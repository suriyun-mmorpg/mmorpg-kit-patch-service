import { acquireWriterLock, type WriterLock } from "./writer-lock";
import { manifestOf, validateChunk, chunkHash, type ChunkedUpload } from "./chunk-protocol";
import { mkdir, open, readFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { ApiError, hash, parseJson, stringifyJson, slug, validateUpload, rejectLegacyEnvironment, type Metadata, type Release, type Upload } from "./model";

interface Stored {
  metadata: Metadata;
  directory: string;
}

// One writer process per data directory. Writes are serialized and directories are
// renamed only after both files have been flushed. No database or mutable index.
export class PatchStore {
  private releases = new Map<string, Stored>();
  private drafts = new Map<string, Stored>();
  private queue: Promise<unknown> = Promise.resolve();
  private closed = false;
  private writerLock?: WriterLock;
  readonly root: string;

  private constructor(root: string) {
    this.root = resolve(root);
  }

  static async open(root: string): Promise<PatchStore> {
    const store = new PatchStore(root);
    await mkdir(store.root, { recursive: true });
    store.writerLock = await acquireWriterLock(store.root);
    try {
      await store.scan();
      return store;
    } catch (error) {
      await store.close();
      throw error;
    }
  }

  private async scan(): Promise<void> {
    await mkdir(join(this.root, "drafts"), { recursive: true });
    await mkdir(join(this.root, "databases"), { recursive: true });
    const glob = new Bun.Glob("**/metadata.json");
    const versions = new Set<string>();
    for await (const relative of glob.scan({ cwd: this.root, onlyFiles: true, followSymlinks: false })) {
      const normalized = relative.replaceAll("\\", "/");
      if (/^databases\/[^/]+\/[^/]+\/versions\/[^/]+\/metadata\.json$/.test(normalized)) {
        throw new Error("Legacy environment folders found. Stop the service and run scripts/migrate-patch-scopes.ts before starting.");
      }
      if (!/^drafts\/[^/]+\/metadata\.json$/.test(normalized) &&
          !/^databases\/[^/]+\/versions\/[^/]+\/metadata\.json$/.test(normalized)) continue;
      const directory = join(this.root, relative, "..");
      const metadata = JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")) as Metadata;
      if (Object.hasOwn(metadata, "environment")) {
        throw new Error("Legacy environment metadata found. Run scripts/migrate-patch-scopes.ts before starting.");
      }
      slug(metadata.id, "id");
      slug(metadata.databaseId, "databaseId");
      if (metadata.schemaVersion !== 1 && metadata.schemaVersion !== 2) {
        throw new Error("Unsupported stored patch schema.");
      }
      const payloadJson = await readFile(join(directory, "payload.json"), "utf8");
      if (metadata.schemaVersion === 2) {
        manifestOf(payloadJson);
        if (normalized.startsWith("databases/")) await this.verifyChunks(directory, payloadJson);
      } else {
        validateUpload({ ...metadata, entries: parseJson(payloadJson) });
      }
      if (hash(payloadJson) !== metadata.payloadHash || !Number.isInteger(metadata.version) ||
          metadata.version < 0 || metadata.version > 2147483647 || !Number.isFinite(Date.parse(metadata.createdAt))) {
        throw new Error(`Invalid patch files in ${relative}. Restore from backup.`);
      }
      const published = relative.replaceAll("\\", "/").startsWith("databases/");
      const expected = published ? this.versionDirectory(metadata) : join(this.root, "drafts", metadata.id);
      if (resolve(directory) !== resolve(expected) || (published ? metadata.version < 1 || !Number.isFinite(Date.parse(metadata.publishTime)) : metadata.version !== 0 || metadata.publishTime !== "")) {
        throw new Error(`Patch folder/metadata mismatch in ${relative}.`);
      }
      const map = published ? this.releases : this.drafts;
      if (map.has(metadata.id)) throw new Error(`Duplicate patch ID in storage: ${metadata.id}`);
      if (published) {
        const versionKey = `${metadata.databaseId}/${metadata.version}`;
        if (versions.has(versionKey)) throw new Error(`Duplicate patch version: ${versionKey}`);
        versions.add(versionKey);
      }
      map.set(metadata.id, { metadata, directory });
    }
    // A crash after publishing can leave the original draft. Check it, but never
    // treat it as a second release or publish it again.
    for (const [id, draft] of this.drafts) {
      const published = this.releases.get(id);
      if (published && !this.same(published.metadata, draft.metadata)) {
        throw new Error(`Conflicting draft and published release: ${id}`);
      }
    }
  }

  private versionDirectory(meta: Metadata): string {
    return join(this.root, "databases", meta.databaseId, "versions", `${String(meta.version).padStart(8, "0")}-${meta.id}`);
  }

  private same(a: Metadata, b: Metadata): boolean {
    return a.databaseId === b.databaseId &&
      a.schemaVersion === b.schemaVersion && a.description === b.description && a.payloadHash === b.payloadHash;
  }

  private mutate<T>(action: () => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new ApiError(503, "Service is shutting down."));
    const next = this.queue.then(action);
    this.queue = next.catch(() => undefined);
    return next;
  }

  private async writeDirectory(destination: string, metadata: Metadata, payload: string, chunkSource?: string): Promise<void> {
    const temp = join(this.root, ".tmp", crypto.randomUUID());
    await mkdir(temp, { recursive: true });
    try {
      for (const [name, content] of [["metadata.json", JSON.stringify(metadata, null, 2)], ["payload.json", payload]] as const) {
        const file = await open(join(temp, name), "wx");
        try {
          await file.writeFile(content, "utf8");
          await file.sync();
        } finally {
          await file.close();
        }
      }
      if (metadata.schemaVersion === 2 && chunkSource) {
        for (const descriptor of manifestOf(payload).chunks) {
          const content = await readFile(join(chunkSource, `chunk-${descriptor.index}.json`), "utf8");
          validateChunk(descriptor, content);
          const file = await open(join(temp, `chunk-${descriptor.index}.json`), "wx");
          try {
            await file.writeFile(content, "utf8");
            await file.sync();
          } finally {
            await file.close();
          }
        }
      }
      await mkdir(join(destination, ".."), { recursive: true });
      await rename(temp, destination);
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  }

  create(input: Upload): Promise<Release> {
    return this.mutate(async () => {
      const payloadJson = stringifyJson(input.entries);
      const metadata: Metadata = {
        id: input.id, databaseId: input.databaseId,
        schemaVersion: input.schemaVersion, description: input.description,
        version: 0, createdAt: new Date().toISOString(), publishTime: "", payloadHash: hash(payloadJson),
      };
      const existing = this.releases.get(input.id) ?? this.drafts.get(input.id);
      if (existing) {
        if (!this.same(existing.metadata, metadata)) throw new ApiError(409, "This release ID already contains different data. Use a new ID.");
        return this.read(existing);
      }
      const directory = join(this.root, "drafts", input.id);
      await this.writeDirectory(directory, metadata, payloadJson);
      this.drafts.set(input.id, { metadata, directory });
      return { ...metadata, payloadJson };
    });
  }

  publish(id: string): Promise<Release> {
    slug(id, "id");
    return this.mutate(async () => {
      const published = this.releases.get(id);
      if (published) return this.read(published);
      const draft = this.drafts.get(id);
      if (!draft) throw new ApiError(404, "Patch draft not found.");
      const source = await this.read(draft);
      const versions = this.list(source.databaseId);
      const version = (versions[0]?.version ?? 0) + 1;
      if (version > 2147483647) throw new ApiError(409, "Patch version limit reached.");
      const { payloadJson, manifestJson, ...draftMeta } = source;
      if (source.schemaVersion === 2) await this.verifyChunks(draft.directory, manifestJson!);
      const metadata = { ...draftMeta, version, publishTime: new Date().toISOString() };
      const directory = this.versionDirectory(metadata);
      await this.writeDirectory(directory, metadata, manifestJson ?? payloadJson, draft.directory);
      this.releases.set(id, { metadata, directory });
      // Keep the draft for recovery/auditing; downloads only read published data.
      return { ...metadata, payloadJson, ...(manifestJson ? { manifestJson } : {}) };
    });
  }

  list(databaseId: string): Metadata[] {
    slug(databaseId, "databaseId");
    return [...this.releases.values()].map(x => ({ ...x.metadata }))
      .filter(x => x.databaseId === databaseId)
      .sort((a, b) => b.version - a.version);
  }

  async latest(databaseId: string): Promise<Release> {
    const latest = this.list(databaseId)[0];
    if (!latest) throw new ApiError(404, "No published patch for this database.");
    return this.get(latest.id);
  }

  async get(id: string): Promise<Release> {
    slug(id, "id");
    const release = this.releases.get(id);
    if (!release) throw new ApiError(404, "Published patch not found.");
    return this.read(release);
  }

  private async read(record: Stored): Promise<Release> {
    const payloadJson = await readFile(join(record.directory, "payload.json"), "utf8");
    if (hash(payloadJson) !== record.metadata.payloadHash) throw new Error("Stored patch failed its integrity check.");
    return record.metadata.schemaVersion === 2
      ? { ...record.metadata, payloadJson: "", manifestJson: payloadJson }
      : { ...record.metadata, payloadJson };
  }

  createChunked(input: ChunkedUpload): Promise<Release> {
    slug(input.id, "id");
    slug(input.databaseId, "databaseId");
    rejectLegacyEnvironment(input as unknown as Record<string, unknown>);
    if (input.schemaVersion !== 2 || (input.description !== undefined && (typeof input.description !== "string" || input.description.length > 2000))) throw new ApiError(400, "Invalid chunked metadata.");
    manifestOf(input.manifestJson);
    return this.mutate(async () => {
      const metadata: Metadata = {
        id: input.id, databaseId: input.databaseId,
        schemaVersion: 2, description: input.description ?? "", version: 0,
        createdAt: new Date().toISOString(), publishTime: "", payloadHash: chunkHash(input.manifestJson),
      };
      const existing = this.releases.get(input.id) ?? this.drafts.get(input.id);
      if (existing) {
        if (!this.same(existing.metadata, metadata)) throw new ApiError(409, "Upload ID already belongs to another snapshot.");
        return this.read(existing);
      }
      const directory = join(this.root, "drafts", input.id);
      await this.writeDirectory(directory, metadata, input.manifestJson);
      this.drafts.set(input.id, { metadata, directory });
      return { ...metadata, payloadJson: "", manifestJson: input.manifestJson };
    });
  }

  uploadChunk(id: string, index: number, payloadJson: string): Promise<{ index: number; hash: string }> {
    slug(id, "id");
    return this.mutate(async () => {
      const record = this.releases.get(id) ?? this.drafts.get(id);
      if (!record || record.metadata.schemaVersion !== 2) throw new ApiError(404, "Chunked release not found.");
      const release = await this.read(record);
      const descriptor = manifestOf(release.manifestJson!).chunks[index];
      if (!Number.isInteger(index) || !descriptor) throw new ApiError(400, "Invalid chunk index.");
      validateChunk(descriptor, payloadJson);
      const path = join(record.directory, `chunk-${index}.json`);
      try {
        const current = await readFile(path, "utf8");
        if (current !== payloadJson) throw new ApiError(409, "Chunk is immutable.");
        return { index, hash: descriptor.hash };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      if (record.metadata.publishTime) throw new ApiError(409, "Published release is immutable.");
      const temp = path + ".tmp";
      const file = await open(temp, "w");
      try {
        await file.writeFile(payloadJson, "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temp, path);
      return { index, hash: descriptor.hash };
    });
  }

  async uploadStatus(id: string): Promise<{ uploadedIndices: number[] }> {
    slug(id, "id");
    const record = this.releases.get(id) ?? this.drafts.get(id);
    if (!record || record.metadata.schemaVersion !== 2) throw new ApiError(404, "Chunked release not found.");
    const release = await this.read(record);
    const uploadedIndices: number[] = [];
    for (const chunk of manifestOf(release.manifestJson!).chunks) {
      try {
        const text = await readFile(join(record.directory, `chunk-${chunk.index}.json`), "utf8");
        validateChunk(chunk, text);
        uploadedIndices.push(chunk.index);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    return { uploadedIndices };
  }

  async getChunk(id: string, index: number): Promise<{ payloadJson: string }> {
    const release = await this.get(id);
    if (release.schemaVersion !== 2) throw new ApiError(404, "Chunk not found.");
    const descriptor = manifestOf(release.manifestJson!).chunks[index];
    if (!Number.isInteger(index) || !descriptor) throw new ApiError(404, "Chunk not found.");
    const payloadJson = await readFile(join(this.releases.get(id)!.directory, `chunk-${index}.json`), "utf8");
    validateChunk(descriptor, payloadJson);
    return { payloadJson };
  }

  private async verifyChunks(directory: string, manifestJson: string): Promise<void> {
    const seen = new Set<string>();
    for (const descriptor of manifestOf(manifestJson).chunks) {
      let content: string;
      try {
        content = await readFile(join(directory, `chunk-${descriptor.index}.json`), "utf8");
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new ApiError(409, `Missing chunk ${descriptor.index}. Upload all chunks before publishing.`);
        throw error;
      }
      validateChunk(descriptor, content, seen);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.queue;
    await this.writerLock?.release();
  }
}
