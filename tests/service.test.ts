import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApp } from "../src/app";
import { PatchStore } from "../src/store";
import { hash, MAX_PAYLOAD_BYTES, MAX_REQUEST_BYTES, type Release } from "../src/model";

const secret = "test-upload-secret-with-at-least-32-characters";
let root: string;
let store: PatchStore;
let app: ReturnType<typeof createApp>;
const entry = { dataType: "JunkItem", dataId: -2147483648, data: { sellPrice: 2147483647, title: "ไทย 日本語" } };
const upload = (id = "release-one", extra = {}) => ({ id, databaseId: "main", schemaVersion: 1, entries: [entry], ...extra });

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "patch-service-test-"));
  store = await PatchStore.open(root);
  app = createApp(store, [secret]);
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

function request(path: string, body?: unknown, key: string | null = secret) {
  const headers: Record<string, string> = {};
  if (key) headers["x-api-key"] = key;
  if (body !== undefined) headers["content-type"] = "application/json";
  return app.handle(new Request(`http://localhost${path}`, {
    method: body === undefined ? "GET" : "POST", headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  }));
}

async function publish(id = "release-one", extra = {}) {
  expect((await request("/game-data-patches", upload(id, extra))).status).toBe(200);
  const response = await request(`/game-data-patches/${id}/publish`, {});
  expect(response.status).toBe(200);
  return response.json() as Promise<Release>;
}

test("Unity draft/publish/download contract preserves Int32 and UTF8 hashes", async () => {
  expect((await request("/game-data-patches/latest?databaseId=main")).status).toBe(404);
  expect((await request("/game-data-patches", upload())).status).toBe(200);
  expect((await request("/game-data-patches/release-one", undefined, null)).status).toBe(404);
  const release = await publish();
  expect(release.version).toBe(1);
  expect(release.publishTime).not.toBe("");
  expect(release.payloadHash).toBe(hash(release.payloadJson));
  expect(JSON.parse(release.payloadJson)).toEqual([entry]);
  const latest = await request("/game-data-patches/latest?databaseId=main", undefined, null);
  expect(await latest.json()).toEqual(release);
  expect(latest.headers.get("cache-control")).toBe("no-store");
  expect((await request("/game-data-patches/release-one", undefined, null)).headers.get("cache-control")).toContain("immutable");
});

test("restart retains versions, scoped latest and idempotency", async () => {
  const first = await publish();
  await publish("release-two");
  await store.close();
  store = await PatchStore.open(root);
  app = createApp(store, [secret]);
  expect(await publish()).toEqual(first);
  expect(((await (await request("/game-data-patches/latest?databaseId=main")).json()) as Release).version).toBe(2);
  expect((await request("/game-data-patches", upload("release-one", { description: "changed" }))).status).toBe(409);
  expect((await publish("production-one", { databaseId: "production" })).version).toBe(1);
});

test("concurrent publishes have unique versions and same-ID retries stay stable", async () => {
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => publish(`parallel-${i}`)));
  expect(results.map(x => x.version).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
  const repeated = await Promise.all(Array.from({ length: 4 }, () => publish("same-id")));
  expect(new Set(repeated.map(x => x.version)).size).toBe(1);
});

test("direct JSON entry, array, envelope and draft uploads", async () => {
  for (const [i, body] of [entry, [entry], upload("direct-2")].entries()) {
    const response = await request(`/game-data-patches/upload?databaseId=main&id=direct-${i}`, body);
    expect(response.status).toBe(200);
    expect(((await response.json()) as Release).version).toBe(i + 1);
  }
  expect(((await (await request("/game-data-patches/upload?publish=false", upload("draft-only"))).json()) as Release).version).toBe(0);
  expect((await request("/game-data-patches/draft-only")).status).toBe(404);
  expect((await request("/game-data-patches/upload?databaseId=other", upload())).status).toBe(400);
});

test("multipart exported files work over a real HTTP listener", async () => {
  app.listen({ hostname: "127.0.0.1", port: 0 });
  try {
    const form = new FormData();
    form.append("files", new File([JSON.stringify(entry)], "one.json"));
    form.append("files", new File([JSON.stringify({ ...entry, dataId: 2147483647 })], "two.json"));
    form.append("files", new File(['{"dataType":"Skill","dataId":42,"data":{"largeFloat":3.40282347E+38,"largeInteger":9223372036854775807}}'], "large.json"));
    const response = await fetch(`${app.server!.url}game-data-patches/upload?databaseId=main&id=files`, {
      method: "POST", headers: { "x-api-key": secret }, body: form,
    });
    expect(response.status).toBe(200);
    const release = await response.json() as { payloadJson: string };
    expect(JSON.parse(release.payloadJson)).toHaveLength(3);
    expect(release.payloadJson).toContain('"largeFloat":3.40282347E+38');
    expect(release.payloadJson).toContain('"largeInteger":9223372036854775807');
  } finally {
    await app.stop();
  }
});

test("authentication and secret rotation", async () => {
  expect(() => createApp(store, [])).toThrow();
  expect(() => createApp(store, ["short"])).toThrow();
  expect((await request("/game-data-patches", upload(), null)).status).toBe(401);
  expect((await request("/game-data-patches/release-one/publish", {}, "wrong")).status).toBe(401);
  expect((await request("/game-data-patches?databaseId=main", undefined, null)).status).toBe(401);
  app = createApp(store, [secret, "another-key-with-at-least-32-characters"]);
  expect((await request("/game-data-patches", upload(), "another-key-with-at-least-32-characters")).status).toBe(200);
});

test("invalid IDs, duplicate entries, non-object data and nesting are rejected", async () => {
  for (const id of ["../escape", "con", "UPPER", "a/b"]) {
    expect((await request("/game-data-patches", upload(id))).status).toBe(400);
  }
  for (const entries of [[entry, entry], [{ ...entry, dataId: 2147483648 }], [{ ...entry, data: 1e30 }]]) {
    expect((await request("/game-data-patches", upload("bad", { entries }))).status).toBe(400);
  }
  let deep: unknown = {};
  for (let i = 0; i < 35; i++) deep = { nested: deep };
  expect((await request("/game-data-patches", upload("deep", { entries: [{ ...entry, data: deep }] }))).status).toBe(400);
});

test("oversized payloads and requests cannot publish", async () => {
  expect((await request("/game-data-patches", upload("huge", { entries: [{ ...entry, data: { text: "x".repeat(MAX_PAYLOAD_BYTES) } }] }))).status).toBe(413);
  const response = await app.handle(new Request("http://localhost/game-data-patches", {
    method: "POST", headers: { "x-api-key": secret, "content-type": "application/json" }, body: " ".repeat(MAX_REQUEST_BYTES + 1),
  }));
  expect(response.status).toBe(413);
  expect(store.list("main")).toHaveLength(0);
});

test("malformed JSON and reserved properties are rejected", async () => {
  for (const body of ["{broken", JSON.stringify(upload()).replace('"sellPrice":2147483647', '"__proto__":{}')]) {
    const response = await app.handle(new Request("http://localhost/game-data-patches", {
      method: "POST", headers: { "x-api-key": secret, "content-type": "application/json" }, body,
    }));
    expect(response.status).toBe(400);
  }
});

test("exclusive writer lock is released on close", async () => {
  await expect(PatchStore.open(root)).rejects.toThrow("locked");
  await store.close();
  store = await PatchStore.open(root);
  app = createApp(store, [secret]);
  expect((await publish()).version).toBe(1);
});

test("corrupt payload fails downloads and startup verification", async () => {
  await publish();
  await writeFile(join(root, "databases/main/versions/00000001-release-one/payload.json"), "[]");
  expect((await request("/game-data-patches/release-one")).status).toBe(500);
  await store.close();
  await expect(PatchStore.open(root)).rejects.toThrow("Invalid patch files");
});

test("empty snapshot can be published", async () => {
  expect((await publish("empty", { entries: [] })).payloadJson).toBe("[]");
});

test("health identifies the deployed numeric codec and version", async () => {
  const response = await request("/health", undefined, null);
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({ version: "2.0.0", numberEncoding: "lossless-json", patchSchemas: [1, 2] });
});

test("Unity large floats and Int64 tokens survive upload, publish and restart exactly", async () => {
  const data = '{"maxFloat":3.40282347E+38,"minFloat":-3.40282347E+38,"largeDouble":1.7976931348623157E+308,"longValue":9223372036854775807,"minLong":-9223372036854775808,"decimal":0.1234567890123456789,"tiny":1E-45,"currency":2147483647,"nested":[9007199254740993]}';
  const body = JSON.stringify(upload("numeric")).replace(JSON.stringify(entry.data), data);
  const response = await app.handle(new Request("http://localhost/game-data-patches", {
    method: "POST", headers: { "x-api-key": secret, "content-type": "application/json" }, body,
  }));
  expect(response.status).toBe(200);
  const published = await request("/game-data-patches/numeric/publish", {});
  expect(published.status).toBe(200);
  const release = await published.json() as Release;
  expect(release.payloadJson).toBe(`[{"dataType":"JunkItem","dataId":-2147483648,"data":${data}}]`);
  expect(release.payloadHash).toBe(hash(release.payloadJson));
  await store.close();
  store = await PatchStore.open(root);
  app = createApp(store, [secret]);
  expect(await store.get("numeric")).toEqual(release);
  expect((await app.handle(new Request("http://localhost/game-data-patches", {
    method: "POST", headers: { "x-api-key": secret, "content-type": "application/json" }, body,
  }))).status).toBe(200);
});

test("out-of-range double tokens still fail validation", async () => {
  const body = JSON.stringify(upload()).replace(JSON.stringify(entry.data), '{"value":1e999}');
  const response = await app.handle(new Request("http://localhost/game-data-patches", {
    method: "POST", headers: { "x-api-key": secret, "content-type": "application/json" }, body,
  }));
  expect(response.status).toBe(400);
  expect(await response.json()).toEqual({ error: "JunkItem:-2147483648: Patch contains a number outside the finite double range." });
});

test("failed disk write does not expose a release and can be retried", async () => {
  expect((await request("/game-data-patches", upload())).status).toBe(200);
  const obstruction = join(root, "databases", "main");
  await writeFile(obstruction, "simulate a storage failure");
  expect((await request("/game-data-patches/release-one/publish", {})).status).toBe(500);
  expect((await request("/game-data-patches/latest?databaseId=main")).status).toBe(404);
  await rm(obstruction);
  expect((await publish()).version).toBe(1);
});

function chunkUpload(id: string, payloads: string[]) {
  const manifestJson = JSON.stringify({ schemaVersion: 2, chunks: payloads.map((payload, index) => ({
    index, dataType: "JunkItem", hash: hash(payload), bytes: Buffer.byteLength(payload), entryCount: JSON.parse(payload).length,
  })) });
  return { id, databaseId: "main", schemaVersion: 2, manifestJson };
}

test("v2 resumes an interrupted upload, publishes >3 MiB, and downloads exact chunks after restart", async () => {
  const payloads = Array.from({ length: 7 }, (_, dataId) => JSON.stringify([{ dataType: "JunkItem", dataId, data: { text: "x".repeat(500000) } }]));
  const dto = chunkUpload("chunked", payloads);
  expect((await request("/game-data-patches/chunked", dto, null)).status).toBe(401);
  expect((await request("/game-data-patches/chunked", dto)).status).toBe(200);
  expect((await request("/game-data-patches/chunked/chunks/0", { payloadJson: payloads[0] })).status).toBe(200);
  expect((await request("/game-data-patches/chunked/chunks/0")).status).toBe(404);
  expect((await request("/game-data-patches/chunked/publish", {})).status).toBe(409);
  expect((await request("/game-data-patches/latest?databaseId=main")).status).toBe(404);
  await store.close();
  store = await PatchStore.open(root);
  app = createApp(store, [secret]);
  expect(await (await request("/game-data-patches/chunked/upload-status", {})).json()).toEqual({ uploadedIndices: [0] });
  for (let i = 1; i < payloads.length; i++) expect((await request(`/game-data-patches/chunked/chunks/${i}`, { payloadJson: payloads[i] })).status).toBe(200);
  const published = await request("/game-data-patches/chunked/publish", {});
  expect(published.status).toBe(200);
  const release = await published.json() as Release;
  expect(release.schemaVersion).toBe(2);
  expect(release.payloadJson).toBe("");
  expect(release.payloadHash).toBe(hash(dto.manifestJson));
  await store.close();
  store = await PatchStore.open(root);
  app = createApp(store, [secret]);
  expect(await (await request("/game-data-patches/chunked")).json()).toEqual(release);
  for (let i = 0; i < payloads.length; i++) expect(await (await request(`/game-data-patches/chunked/chunks/${i}`, undefined, null)).json()).toEqual({ payloadJson: payloads[i] });
  expect((await request("/game-data-patches/chunked/chunks/0", { payloadJson: payloads[0] })).status).toBe(200);
  expect((await request("/game-data-patches/chunked/chunks/0", { payloadJson: "[]" })).status).toBe(400);
});

test("v2 rejects tampering, conflicting manifests and cross-chunk duplicates", async () => {
  const payload = '[{"dataType":"JunkItem","dataId":1,"data":{"price":9223372036854775807,"float":3.40282347E+38}}]';
  const dto = chunkUpload("duplicate", [payload, payload]);
  expect((await request("/game-data-patches/chunked", dto)).status).toBe(200);
  expect((await request("/game-data-patches/chunked", { ...dto, description: "changed" })).status).toBe(409);
  expect((await request("/game-data-patches/duplicate/chunks/0", { payloadJson: payload.replace("price", "cost") })).status).toBe(400);
  for (let i = 0; i < 2; i++) expect((await request(`/game-data-patches/duplicate/chunks/${i}`, { payloadJson: payload })).status).toBe(200);
  expect((await request("/game-data-patches/duplicate/publish", {})).status).toBe(400);
  const valid = chunkUpload("precise", [payload]);
  await request("/game-data-patches/chunked", valid);
  await request("/game-data-patches/precise/chunks/0", { payloadJson: payload });
  expect((await request("/game-data-patches/precise/publish", {})).status).toBe(200);
  expect(await (await request("/game-data-patches/precise/chunks/0")).json()).toEqual({ payloadJson: payload });
});

test("database ID alone scopes latest, versions, uploads and responses", async () => {
  const first = await publish("main-one");
  const other = await publish("test-one", { databaseId: "test" });
  expect(first).not.toHaveProperty("environment");
  expect(other.version).toBe(1);
  expect((await publish("main-two")).version).toBe(2);
  expect((await store.latest("main")).id).toBe("main-two");
  expect((await store.latest("test")).id).toBe("test-one");
  expect((await request("/game-data-patches", upload("main-one", { databaseId: "test" }))).status).toBe(409);
  const payload = JSON.stringify([entry]);
  const chunked = { ...chunkUpload("main-three", [payload]), databaseId: "main" };
  expect((await request("/game-data-patches/chunked", chunked)).status).toBe(200);
  await request("/game-data-patches/main-three/chunks/0", { payloadJson: payload });
  const release = await (await request("/game-data-patches/main-three/publish", {})).json() as Release;
  expect(release.version).toBe(3);
  expect(release).not.toHaveProperty("environment");
  expect((await store.latest("test")).id).toBe("test-one");
});

test("old environment parameters fail clearly instead of selecting the wrong stream", async () => {
  expect((await request("/game-data-patches", upload("old", { environment: "staging" }))).status).toBe(400);
  expect((await request("/game-data-patches/chunked", { ...chunkUpload("old-chunks", ["[]"]), environment: "staging" })).status).toBe(400);
  for (const route of ["/game-data-patches/latest", "/game-data-patches"]) {
    expect((await request(route + "?databaseId=main&environment=staging")).status).toBe(400);
  }
  expect((await request("/game-data-patches/upload?databaseId=main&environment=staging", [entry])).status).toBe(400);
});
