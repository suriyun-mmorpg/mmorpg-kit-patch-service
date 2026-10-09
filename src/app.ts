import { ChunkProtocolError, type ChunkedUpload } from "./chunk-protocol";
import { version } from "../package.json";
import { Elysia } from "elysia";
import { timingSafeEqual } from "node:crypto";
import { ApiError, hash, MAX_REQUEST_BYTES, object, parseJson, validateUpload, rejectLegacyEnvironment } from "./model";
import { PatchStore } from "./store";

async function readBody(request: Request): Promise<Uint8Array> {
  if (Number(request.headers.get("content-length")) > MAX_REQUEST_BYTES) throw new ApiError(413, "Request is too large.");
  const reader = request.body?.getReader();
  if (!reader) throw new ApiError(400, "JSON or multipart body required.");
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > MAX_REQUEST_BYTES) {
        await reader.cancel();
        throw new ApiError(413, "Request is too large.");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

function decode(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ApiError(400, "JSON files must use UTF-8 encoding.");
  }
}

export function createApp(store: PatchStore, secrets: string[]) {
  if (!secrets.length || secrets.some(secret => secret.trim().length < 32)) {
    throw new Error("PATCH_UPLOAD_SECRET_KEYS requires one or more keys of at least 32 characters.");
  }
  const hashes = secrets.map(secret => Buffer.from(hash(secret), "hex"));
  function authorize(request: Request): void {
    const supplied = request.headers.get("x-api-key");
    const digest = Buffer.from(hash(supplied ?? ""), "hex");
    let matches = false;
    for (const expected of hashes) matches = timingSafeEqual(expected, digest) || matches;
    if (!supplied || !matches) throw new ApiError(401, "Invalid or missing upload key.");
  }
  async function jsonBody(request: Request): Promise<unknown> {
    if (request.headers.get("content-type")?.split(";")[0]?.trim() !== "application/json") {
      throw new ApiError(415, "Use Content-Type: application/json.");
    }
    return parseJson(decode(await readBody(request)));
  }

  return new Elysia({ serve: { maxRequestBodySize: MAX_REQUEST_BYTES } })
    .onError(({ error, code, set }) => {
      if (error instanceof ChunkProtocolError) {
        set.status = 400;
        return { error: error.message };
      }
      if (error instanceof ApiError) {
        set.status = error.status;
        return { error: error.message };
      }
      if (code === "NOT_FOUND") {
        set.status = 404;
        return { error: "Route not found." };
      }
      if (code === "PARSE" || code === "VALIDATION") {
        set.status = 400;
        return { error: "Invalid request." };
      }
      console.error("Patch service request failed:", error instanceof Error ? error.name : "UnknownError");
      set.status = 500;
      return { error: "Patch storage could not complete the request." };
    })
    .onBeforeHandle(({ query }) => {
      rejectLegacyEnvironment(query);
    })
    .get("/health", () => ({ status: "ok", service: "mmorpg-kit-patch-service", version, numberEncoding: "lossless-json", patchSchemas: [1, 2] }))
    .get("/game-data-patches/latest", async ({ query, set }) => {
      set.headers["cache-control"] = "no-store";
      return store.latest(query.databaseId ?? "");
    })
    .get("/game-data-patches", ({ request, query, set }) => {
      authorize(request);
      set.headers["cache-control"] = "no-store";
      return store.list(query.databaseId ?? "");
    })
    .get("/game-data-patches/:id", async ({ params, set }) => {
      const release = await store.get(params.id);
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      set.headers.etag = `"${release.payloadHash}"`;
      return release;
    })
    .post("/game-data-patches/chunked", async ({ request }) => {
      authorize(request);
      const body = await jsonBody(request);
      if (!object(body)) throw new ApiError(400, "Expected upload metadata.");
      return store.createChunked(body as unknown as ChunkedUpload);
    }, { parse: "none" })
    .post("/game-data-patches/:id/upload-status", ({ request, params }) => {
      authorize(request);
      return store.uploadStatus(params.id);
    }, { parse: "none" })
    .post("/game-data-patches/:id/chunks/:index", async ({ request, params }) => {
      authorize(request);
      const body = await jsonBody(request);
      if (!object(body) || typeof body.payloadJson !== "string") throw new ApiError(400, "Expected payloadJson string.");
      return store.uploadChunk(params.id, Number(params.index), body.payloadJson);
    }, { parse: "none" })
    .get("/game-data-patches/:id/chunks/:index", async ({ params, set }) => {
      const result = await store.getChunk(params.id, Number(params.index));
      set.headers["cache-control"] = "public, max-age=31536000, immutable";
      return result;
    })
    .post("/game-data-patches", async ({ request }) => {
      authorize(request);
      return store.create(validateUpload(await jsonBody(request)));
    }, { parse: "none" })
    .post("/game-data-patches/:id/publish", async ({ request, params }) => {
      authorize(request);
      return store.publish(params.id);
    }, { parse: "none" })
    .post("/game-data-patches/upload", async ({ request, query }) => {
      authorize(request);
      if (query.publish !== undefined && !["true", "false"].includes(query.publish)) {
        throw new ApiError(400, "publish must be true or false.");
      }
      const contentType = request.headers.get("content-type") ?? "";
      let value: unknown;
      if (contentType.startsWith("multipart/form-data")) {
        const bytes = await readBody(request);
        let form: Awaited<ReturnType<Response["formData"]>>;
        try {
          form = await new Response(Buffer.from(bytes), { headers: { "content-type": contentType } }).formData();
        } catch {
          throw new ApiError(400, "Invalid multipart form.");
        }
        const files = [...form.getAll("file"), ...form.getAll("files")];
        if (!files.length || files.some(file => !(file instanceof File))) {
          throw new ApiError(400, "Attach JSON files in file or files fields.");
        }
        const documents = await Promise.all((files as File[]).map(async file => parseJson(decode(new Uint8Array(await file.arrayBuffer())))));
        value = documents.length === 1 ? documents[0] : documents.flatMap(document => Array.isArray(document) ? document : [document]);
      } else {
        value = await jsonBody(request);
      }
      // Upload either the Unity envelope, an entry array, or individual exported records.
      const envelope = object(value) && Array.isArray(value.entries) ? value : {
        schemaVersion: 1, entries: Array.isArray(value) ? value : [value],
      };
      for (const field of ["id", "databaseId", "description"] as const) {
        if (query[field] !== undefined) {
          if (envelope[field] !== undefined && envelope[field] !== query[field]) throw new ApiError(400, `Conflicting ${field}.`);
          envelope[field] = query[field];
        }
      }
      const draft = await store.create(validateUpload(envelope));
      return query.publish === "false" ? draft : store.publish(draft.id);
    }, { parse: "none" });
}
