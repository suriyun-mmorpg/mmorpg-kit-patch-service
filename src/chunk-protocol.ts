import { createHash } from "crypto";

export const MAX_CHUNK_BYTES = 1024 * 1024;
export const MAX_RELEASE_BYTES = 128 * 1024 * 1024;
export const MAX_MANIFEST_BYTES = 256 * 1024;
export interface PatchChunk { index: number; dataType: string; hash: string; bytes: number; entryCount: number; }
export interface PatchManifest { schemaVersion: number; chunks: PatchChunk[]; }
export interface ChunkedUpload { id: string; databaseId: string; schemaVersion: number; description?: string; manifestJson: string; }
export class ChunkProtocolError extends Error {}
export const chunkHash = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

export function manifestOf(text: string): PatchManifest {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_MANIFEST_BYTES) throw new ChunkProtocolError("Manifest exceeds 256 KiB.");
  let manifest: PatchManifest;
  try { manifest = JSON.parse(text); } catch { throw new ChunkProtocolError("Invalid manifest JSON."); }
  if (!manifest || manifest.schemaVersion !== 2 || !Array.isArray(manifest.chunks) || manifest.chunks.length > 1024) throw new ChunkProtocolError("Invalid version-2 manifest.");
  let bytes = 0;
  let entries = 0;
  for (let i = 0; i < manifest.chunks.length; i++) {
    const c = manifest.chunks[i];
    if (!c || c.index !== i || typeof c.dataType !== "string" || !/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(c.dataType) ||
        typeof c.hash !== "string" || !/^[a-f0-9]{64}$/.test(c.hash) ||
        !Number.isInteger(c.bytes) || c.bytes < 2 || c.bytes > MAX_CHUNK_BYTES ||
        !Number.isInteger(c.entryCount) || c.entryCount < 1 || c.entryCount > 20000) throw new ChunkProtocolError("Invalid chunk descriptor.");
    bytes += c.bytes;
    entries += c.entryCount;
  }
  if (bytes > MAX_RELEASE_BYTES || entries > 20000) throw new ChunkProtocolError("Release exceeds 128 MiB or 20000 records.");
  return manifest;
}

export function validateChunk(chunk: PatchChunk, payload: string, seen = new Set<string>()): void {
  if (typeof payload !== "string" || Buffer.byteLength(payload, "utf8") !== chunk.bytes || chunkHash(payload) !== chunk.hash) throw new ChunkProtocolError("Chunk size or hash mismatch.");
  let entries: any;
  try { entries = JSON.parse(payload); } catch { throw new ChunkProtocolError("Invalid chunk JSON."); }
  if (!Array.isArray(entries) || entries.length !== chunk.entryCount) throw new ChunkProtocolError("Chunk record count mismatch.");
  const check = (value: any, depth: number): void => {
    if (depth > 32) throw new ChunkProtocolError("Patch nesting exceeds 32 levels.");
    if (typeof value === "number" && !Number.isFinite(value)) throw new ChunkProtocolError("Non-finite patch number.");
    if (Array.isArray(value) && value.length > 20000) throw new ChunkProtocolError("Patch array exceeds 20000 entries.");
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (["__proto__", "prototype", "constructor"].includes(key)) throw new ChunkProtocolError("Reserved JSON property.");
        check(child, depth + 1);
      }
    }
  };
  for (const entry of entries) {
    if (!entry || entry.dataType !== chunk.dataType || !Number.isInteger(entry.dataId) || entry.dataId < -2147483648 || entry.dataId > 2147483647 ||
        !entry.data || typeof entry.data !== "object" || Array.isArray(entry.data)) throw new ChunkProtocolError("Invalid chunk record.");
    const key = entry.dataType + ":" + entry.dataId;
    if (seen.has(key)) throw new ChunkProtocolError("Duplicate patch record: " + key);
    seen.add(key);
    check(entry.data, 0);
  }
  // Keep the original string. Validation must never reserialize Int64/float values.
}
