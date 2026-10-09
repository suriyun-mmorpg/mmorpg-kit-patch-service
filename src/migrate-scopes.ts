import { acquireWriterLock } from "./writer-lock";
import { copyFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { manifestOf, validateChunk } from "./chunk-protocol";
import { hash, parseJson, slug, validateUpload, type Metadata } from "./model";
import { PatchStore } from "./store";

export interface ScopeMapping {
  databaseId: string;
  environment: string;
  targetDatabaseId: string;
}

interface MigrationRecord {
  source: string;
  target: string;
  metadata: Metadata;
  files: string[];
}

export function scopeMappings(value: unknown): Map<string, string> {
  if (!Array.isArray(value)) throw new Error("The scope map must be a JSON array.");
  const mappings = new Map<string, string>();
  const targets = new Set<string>();
  for (const row of value as ScopeMapping[]) {
    if (!row || typeof row !== "object") throw new Error("Invalid scope mapping.");
    slug(row.databaseId, "databaseId");
    slug(row.environment, "legacy environment");
    slug(row.targetDatabaseId, "targetDatabaseId");
    const key = JSON.stringify([row.databaseId, row.environment]);
    if (mappings.has(key) || targets.has(row.targetDatabaseId)) {
      throw new Error("Every old scope and target databaseId must be unique. Patch histories cannot be merged.");
    }
    mappings.set(key, row.targetDatabaseId);
    targets.add(row.targetDatabaseId);
  }
  return mappings;
}

function overlaps(a: string, b: string): boolean {
  const path = relative(a, b);
  return path === "" || (!path.startsWith(".." + (process.platform === "win32" ? "\\" : "/")) && path !== ".." && !isAbsolute(path));
}

// Copy into a new storage root. Original release IDs, versions and hashed files remain intact.
export async function migrateScopes(sourceRoot: string, destinationRoot: string, mapping: unknown, apply = false) {
  const sourceRootPath = resolve(sourceRoot);
  const destinationRootPath = resolve(destinationRoot);
  if (overlaps(sourceRootPath, destinationRootPath) || overlaps(destinationRootPath, sourceRootPath)) {
    throw new Error("Source and destination must be separate, non-overlapping directories.");
  }
  if (!(await stat(sourceRootPath)).isDirectory()) throw new Error("Source must be a directory.");
  try {
    await stat(destinationRootPath);
    throw new Error("Destination already exists. Choose a new empty storage path.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const mappings = scopeMappings(mapping);
  const lock = await acquireWriterLock(sourceRootPath, "migration");
  try {
    const records: MigrationRecord[] = [];
    const identities = new Map<string, Metadata>();
    const versions = new Set<string>();
    const publishedIds = new Set<string>();
    const glob = new Bun.Glob("**/metadata.json");
    for await (const path of glob.scan({ cwd: sourceRootPath, onlyFiles: true, followSymlinks: false })) {
      const normalized = path.replaceAll("\\", "/");
      if (/^databases\/[^/]+\/versions\/[^/]+\/metadata\.json$/.test(normalized)) {
        throw new Error("Source already contains database-only storage.");
      }
      const published = /^databases\/[^/]+\/[^/]+\/versions\/[^/]+\/metadata\.json$/.test(normalized);
      if (!published && !/^drafts\/[^/]+\/metadata\.json$/.test(normalized)) continue;
      const directory = resolve(sourceRootPath, path, "..");
      const legacy = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8"));
      slug(legacy.id, "id");
      slug(legacy.databaseId, "databaseId");
      slug(legacy.environment, "legacy environment");
      const targetDatabaseId = mappings.get(JSON.stringify([legacy.databaseId, legacy.environment]));
      if (!targetDatabaseId) throw new Error("Missing scope mapping for " + legacy.databaseId + "/" + legacy.environment);
      const { environment, ...rest } = legacy;
      const metadata: Metadata = { ...rest, databaseId: targetDatabaseId };
      const folder = String(metadata.version).padStart(8, "0") + "-" + metadata.id;
      const expected = published
        ? join(sourceRootPath, "databases", legacy.databaseId, environment, "versions", folder)
        : join(sourceRootPath, "drafts", metadata.id);
      if (directory !== resolve(expected) || !Number.isInteger(metadata.version) ||
          (published ? metadata.version < 1 || !Number.isFinite(Date.parse(metadata.publishTime)) : metadata.version !== 0 || metadata.publishTime !== "") ||
          metadata.version > 2147483647 || !Number.isFinite(Date.parse(metadata.createdAt))) {
        throw new Error("Invalid legacy folder/metadata: " + normalized);
      }
      const payload = await readFile(join(directory, "payload.json"), "utf8");
      if (hash(payload) !== metadata.payloadHash) throw new Error("Legacy payload hash mismatch: " + metadata.id);
      const files = ["payload.json"];
      if (metadata.schemaVersion === 1) {
        validateUpload({ ...metadata, entries: parseJson(payload) });
      } else if (metadata.schemaVersion === 2) {
        const seen = new Set<string>();
        for (const descriptor of manifestOf(payload).chunks) {
          const file = "chunk-" + descriptor.index + ".json";
          let content: string;
          try {
            content = await readFile(join(directory, file), "utf8");
          } catch (error) {
            if (!published && (error as NodeJS.ErrnoException).code === "ENOENT") continue;
            throw error;
          }
          validateChunk(descriptor, content, seen);
          files.push(file);
        }
      } else {
        throw new Error("Unsupported legacy schema: " + metadata.schemaVersion);
      }
      const previous = identities.get(metadata.id);
      if (previous && (previous.databaseId !== metadata.databaseId || previous.payloadHash !== metadata.payloadHash ||
          previous.schemaVersion !== metadata.schemaVersion || previous.description !== metadata.description)) {
        throw new Error("Conflicting legacy release ID: " + metadata.id);
      }
      identities.set(metadata.id, metadata);
      if (published) {
        if (publishedIds.has(metadata.id)) throw new Error("Duplicate published legacy release ID: " + metadata.id);
        publishedIds.add(metadata.id);
        const versionKey = metadata.databaseId + "/" + metadata.version;
        if (versions.has(versionKey)) throw new Error("Duplicate legacy version: " + versionKey);
        versions.add(versionKey);
      }
      records.push({
        source: directory,
        target: published ? join("databases", targetDatabaseId, "versions", folder) : join("drafts", metadata.id),
        metadata, files,
      });
    }
    if (apply) {
      await mkdir(destinationRootPath);
      for (const record of records) {
        const directory = join(destinationRootPath, record.target);
        await mkdir(directory, { recursive: true });
        for (const file of record.files) await copyFile(join(record.source, file), join(directory, file));
        await writeFile(join(directory, "metadata.json"), JSON.stringify(record.metadata, null, 2), { flag: "wx" });
      }
      const verified = await PatchStore.open(destinationRootPath);
      await verified.close();
    }
    return records.map(record => ({ id: record.metadata.id, databaseId: record.metadata.databaseId, version: record.metadata.version, target: record.target }));
  } finally {
    await lock.release();
  }
}
