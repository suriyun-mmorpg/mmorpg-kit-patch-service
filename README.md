# MMORPG Kit Patch Service

Standalone Bun + Elysia service for UnityMultiplayerARPG. No database or wzx-user-service dependency. JSON snapshots are stored in immutable version folders per game database ID.

## Setup

Requires Bun 1.4.0 or later (tested with 1.4.0).

```powershell
bun install --frozen-lockfile
Copy-Item .env.example .env
bun -e 'console.log(crypto.randomUUID()+crypto.randomUUID())'
```

Paste the generated key into `PATCH_UPLOAD_SECRET_KEYS` in `.env`, then run `bun start`. Bun loads `.env` automatically. Restart after changing code or configuration.

After upgrading, run `bun install --frozen-lockfile` and restart the service. Open `/health` to confirm the running version: this release reports `version: "2.0.0"` and `numberEncoding: "lossless-json"`. Numeric preservation uses a dedicated parser, without relying on native JSON source-text APIs.

| Variable | Default | Meaning |
| --- | --- | --- |
| `HOST` | `127.0.0.1` | Use `0.0.0.0` for remote/container access |
| `PORT` | `3000` | HTTP port |
| `PATCH_DATA_DIR` | `./data` | Persistent storage, relative to working directory |
| `PATCH_UPLOAD_SECRET_KEYS` | Required | Comma-separated keys, each at least 32 characters |

## Chunked uploads and downloads

The Unity uploader now uses schema version 2. See [the shared version-2 protocol and migration guide](docs/patch-chunks-v2.md). Releases support up to 128 MiB through individually uploaded/downloaded chunks, with resumable uploads and hash-verified client caches. The direct JSON/multipart examples below remain version-1 endpoints (3 MiB).

Version-2 folders contain `payload.json` (the manifest), `metadata.json`, and `chunk-0.json`, `chunk-1.json`, etc. No assembled release payload is stored. Drafts may be incomplete; published folders contain every verified chunk.

## Connect Unity

Use updated Unity clients and servers with the database-only patch contract. See [the migration guide](docs/database-only-patch-scope.md) before upgrading existing storage.

1. Set the service URL to `http://127.0.0.1:3000` locally, or your HTTPS URL remotely. Do not append `/game-data-patches`.
2. Set the profile's patch database ID, such as `main`. Use another ID, such as `test`, for an independent patch stream.
3. Use **Configure Upload Secret** to enter the service key.
4. Review and upload/publish using the existing editor button.
5. Assign the profile to GameInstance and enable patching. Clients, servers, and the Editor always load the latest published patch at startup.

Unity requires HTTPS outside loopback; use an HTTPS reverse proxy for remote hosting. Published balance downloads are public; upload keys belong in editor/server configuration.

Database IDs and release IDs must be lowercase slugs: 1-96 ASCII letters, digits, underscores or hyphens, starting with a letter/digit. Windows device names are rejected. Release IDs are globally unique. Use matching scope values in Unity.

The service preserves JSON numbers, including UnityMultiplayerARPG's Int32 currency values, without converting them to Int64 or strings. Large integers and floating-point values retain their original JSON number tokens instead of being rounded through JavaScript numbers. Data IDs must be signed Int32. Unity validates actual game fields and resolves references.

## Upload JSON files

Accepts an entry array, one exported record with its `dataType`, `dataId`, and `data` wrapper, or an envelope containing `entries` and scope metadata. Replace illustrative IDs/fields in `examples/entries.json` with actual exports.

Every release is a complete patch snapshot, not a merge with previous versions. Include all records that should belong to that snapshot.

Set the PowerShell environment variable `PATCH_UPLOAD_KEY` to your configured secret:

```powershell
curl.exe --fail-with-body -X POST "http://127.0.0.1:3000/game-data-patches/upload?databaseId=main&id=balance-001" -H "x-api-key: $env:PATCH_UPLOAD_KEY" -H "Content-Type: application/json" --data-binary "@examples/entries.json"
```

Multipart accepts repeated `file` or `files` fields containing records or arrays. One file may contain a whole envelope:

```powershell
curl.exe --fail-with-body -X POST "http://127.0.0.1:3000/game-data-patches/upload?databaseId=main&id=balance-002" -H "x-api-key: $env:PATCH_UPLOAD_KEY" -F "files=@item.json" -F "files=@monster.json"
```

Extract Unity export ZIPs first; upload the JSON records, not ZIP input. Uploaded filenames are never storage paths.

The upload endpoint publishes immediately by default. Add `&publish=false` to save a draft. Supply a unique `id` for safe retries; otherwise each request generates a new ID. Identical retries return the existing release. Reusing an ID with changed entries, scope, schema or description returns `409`. Envelope/query metadata must agree when both are supplied.

## HTTP API

| Method and route | Authentication | Result |
| --- | --- | --- |
| `GET /health` | Public | Availability |
| `POST /game-data-patches` | `x-api-key` | Create draft from Unity envelope |
| `POST /game-data-patches/:id/publish` | `x-api-key` | Publish draft; safe to retry |
| `POST /game-data-patches/upload` | `x-api-key` | JSON/multipart upload; publishes by default |
| `GET /game-data-patches?databaseId=main` | `x-api-key` | Published metadata, newest first |
| `GET /game-data-patches/latest?databaseId=main` | Public | Latest release in scope |
| `GET /game-data-patches/:id` | Public | Exact published release |

Unity upload envelope:

```json
{
  "id": "balance-003",
  "databaseId": "main",
  "schemaVersion": 1,
  "description": "Item price adjustment",
  "entries": [
    { "dataType": "JunkItem", "dataId": 123456, "data": { "sellPrice": 10 } }
  ]
}
```

Responses contain `id`, `databaseId`, `schemaVersion`, `description`, `version`, `createdAt`, `publishTime`, `payloadHash`, and `payloadJson`. The latter is a string containing the compact JSON entry array. Its exact UTF-8 bytes produce the lowercase SHA-256 hash. Drafts have version `0` and empty publish time; published versions start at `1` independently per scope.

Latest returns `404` when no release exists, which Unity treats as baseline. Drafts are not publicly downloadable. Exact releases use immutable cache headers; latest uses `no-store`. Republishing an old ID does not move latest backward. Upload an earlier snapshot under a new ID to restore it as latest.

Errors return `{ "error": "message" }`: `400` invalid data, `401` missing/invalid key, `404` absent release, `409` ID conflict, `413` oversized data, `415` incorrect content type, `500` storage failure.

Old requests containing an `environment` parameter are rejected with HTTP 400. Update the editor and runtime together.

## Storage and operation

```text
data/
  .writer.lock
  drafts/balance-001/
    metadata.json
    payload.json
  databases/main/versions/
    00000001-balance-001/
      metadata.json
      payload.json
    00000002-balance-002/
      metadata.json
      payload.json
```

`payload.json` contains entries; `metadata.json` contains release metadata. Drafts remain for auditing. Writes are queued, flushed, and renamed from temporary folders. A release is exposed only after both files are ready. Startup rebuilds the catalog and checks hashes; downloads check hashes again.

Run **one process per local storage directory**. Normal shutdown removes its own `.writer.lock`. Startup automatically recovers a valid local lock only when the owner PID has definitely exited. Active owners, permission errors, malformed locks and locks from other hosts are not removed. PID reuse is treated conservatively as an active owner. A `.writer-recovery.lock` serializes recovery; an interrupted recovery mutex requires manual inspection. Do not delete either lock unconditionally at startup. PIDs must refer to the same host/process namespace; shared storage across hosts or containers is unsupported. Unfinished `.tmp` folders are ignored and can be removed while stopped. Back up the entire directory while stopped. Do not edit published files; upload a new version. Restore corrupt storage from backup before restarting.

Limits: **3 MiB UTF-8 payload** (current Unity client limit), **8 MiB request**, **20,000 records**, **20,000 entries per nested array**, nesting depth **32**. Duplicate `(dataType, dataId)` records and numeric values outside the finite double range are rejected. Empty entry arrays are accepted. Larger snapshots require coordinated client/service limit changes.

For key rotation, configure `old-key,new-key`, update editor secrets, then remove the old key and restart. `.env` and runtime data are excluded from Git and Docker build context.

## Docker

```powershell
docker build -t mmorpg-kit-patch-service .
docker run --rm -p 3000:3000 --env-file .env -e HOST=0.0.0.0 -e PATCH_DATA_DIR=/app/data -v mmorpg-patches:/app/data mmorpg-kit-patch-service
```

Use persistent storage and an HTTPS reverse proxy. No database container is needed.

## Verification

Run `bun run check` for TypeScript checking and integration tests covering Unity routes, public downloads, authentication/rotation, JSON and multipart HTTP uploads, restart persistence, concurrency, retries, validation limits, storage locking, and corruption detection.
