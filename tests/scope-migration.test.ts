import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { hash, type Upload } from "../src/model";
import { migrateScopes, scopeMappings } from "../src/migrate-scopes";
import { PatchStore } from "../src/store";

let root: string;
let source: string;
let destination: string;
const map = [
  { databaseId: "main", environment: "staging", targetDatabaseId: "main" },
  { databaseId: "main", environment: "production", targetDatabaseId: "main-live" },
];
const payload = '[{"dataType":"JunkItem","dataId":1,"data":{"price":9223372036854775807,"title":"ไทย"}}]';

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "patch-scope-migration-"));
  source = join(root, "old-data");
  destination = join(root, "new-data");
  await mkdir(source);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function legacy(id: string, environment: string, version: number, chunked = false, incomplete = false) {
  const directory = version
    ? join(source, "databases", "main", environment, "versions", String(version).padStart(8, "0") + "-" + id)
    : join(source, "drafts", id);
  await mkdir(directory, { recursive: true });
  const text = chunked ? JSON.stringify({ schemaVersion: 2, chunks: [
    { index: 0, dataType: "JunkItem", hash: hash(payload), bytes: Buffer.byteLength(payload), entryCount: 1 },
  ] }) : payload;
  const metadata = { id, databaseId: "main", environment, schemaVersion: chunked ? 2 : 1, description: "",
    version, payloadHash: hash(text), createdAt: "2026-10-09T00:00:00Z", publishTime: version ? "2026-10-09T00:01:00Z" : "" };
  await writeFile(join(directory, "metadata.json"), JSON.stringify(metadata));
  await writeFile(join(directory, "payload.json"), text);
  if (chunked && !incomplete) await writeFile(join(directory, "chunk-0.json"), payload);
  return directory;
}

test("dry-run and copy migration preserve separate histories, hashes, Int64 text and resumable drafts", async () => {
  const old = await legacy("staging-release", "staging", 2);
  const live = await legacy("live-release", "production", 2, true);
  await legacy("draft-release", "production", 0, true, true);
  const originalMetadata = await readFile(join(old, "metadata.json"), "utf8");
  const plan = await migrateScopes(source, destination, map);
  expect(plan).toHaveLength(3);
  await expect(stat(destination)).rejects.toThrow();
  expect(await readFile(join(old, "metadata.json"), "utf8")).toBe(originalMetadata);
  await migrateScopes(source, destination, map, true);
  expect(await readFile(join(old, "metadata.json"), "utf8")).toBe(originalMetadata);
  const store = await PatchStore.open(destination);
  try {
    const staged = await store.latest("main");
    const production = await store.latest("main-live");
    expect(staged.version).toBe(2);
    expect(staged.payloadJson).toBe(payload);
    expect(production.version).toBe(2);
    expect(production.payloadHash).toBe(hash(await readFile(join(live, "payload.json"), "utf8")));
    expect(production).not.toHaveProperty("environment");
    expect(await store.getChunk("live-release", 0)).toEqual({ payloadJson: payload });
    expect(await store.uploadStatus("draft-release")).toEqual({ uploadedIndices: [] });
    await store.uploadChunk("draft-release", 0, payload);
    expect((await store.publish("draft-release")).version).toBe(3);
    const upload: Upload = { id: "next-main", databaseId: "main", schemaVersion: 1, description: "", entries: [] };
    await store.create(upload);
    expect((await store.publish(upload.id)).version).toBe(3);
  } finally {
    await store.close();
  }
  const restarted = await PatchStore.open(destination);
  try {
    expect((await restarted.latest("main-live")).id).toBe("draft-release");
    expect((await restarted.latest("main")).id).toBe("next-main");
  } finally {
    await restarted.close();
  }
});

test("legacy storage cannot silently start as an empty or merged database", async () => {
  await legacy("old-release", "staging", 1);
  await expect(PatchStore.open(source)).rejects.toThrow("Legacy environment");
  await expect(stat(join(source, ".writer.lock"))).rejects.toThrow();
});

test("missing mappings, merged destinations and existing output fail before copying", async () => {
  await legacy("staging-release", "staging", 1);
  await legacy("live-release", "production", 1);
  await expect(migrateScopes(source, destination, [map[0]], true)).rejects.toThrow("Missing scope mapping");
  await expect(stat(destination)).rejects.toThrow();
  expect(() => scopeMappings([map[0], { ...map[1], targetDatabaseId: "main" }])).toThrow("cannot be merged");
  await mkdir(destination);
  await expect(migrateScopes(source, destination, map, true)).rejects.toThrow("already exists");
  await expect(migrateScopes(source, join(source, "nested"), map)).rejects.toThrow("non-overlapping");
});

test("locked or corrupt source fails without modifying history", async () => {
  const old = await legacy("old-release", "staging", 1);
  await writeFile(join(source, ".writer.lock"), "service");
  await expect(migrateScopes(source, destination, map)).rejects.toThrow("Stop the patch service");
  expect(await readFile(join(source, ".writer.lock"), "utf8")).toBe("service");
  await rm(join(source, ".writer.lock"));
  await writeFile(join(old, "payload.json"), "[]");
  await expect(migrateScopes(source, destination, map, true)).rejects.toThrow("hash mismatch");
  await expect(stat(destination)).rejects.toThrow();
});

test("duplicate published IDs fail before copying even when versions differ", async () => {
  await legacy("duplicate", "staging", 1);
  await legacy("duplicate", "staging", 2);
  await expect(migrateScopes(source, destination, map, true)).rejects.toThrow("Duplicate published legacy release ID");
  await expect(stat(destination)).rejects.toThrow();
});
