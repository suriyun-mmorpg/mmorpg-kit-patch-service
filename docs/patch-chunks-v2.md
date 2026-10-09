## Chunked releases (schema version 2)

Deploy both service updates and updated Unity clients/servers before publishing a version-2 release. Old clients only understand version 1 and cannot load a version-2 latest release. Previously published version-1 releases stay immutable and remain downloadable by their exact IDs.

Patch streams are identified by database ID alone. See [the scope migration guide](database-only-patch-scope.md) when upgrading existing data.

### Upload

The Unity review window now groups records by data type and creates chunks targeting 512 KiB. It sends a manifest first, then each chunk separately, and publishes only after completion. The progress dialog can cancel between requests. Retry with the same reviewed snapshot resumes the same upload and skips chunks already stored. Changing the snapshot, description, database ID or service URL creates a new upload ID.

All write/status routes require the existing `x-api-key` upload secret:

1. `POST /game-data-patches/chunked`: `{id,databaseId,schemaVersion:2,description,manifestJson}`.
2. `POST /game-data-patches/:id/upload-status`: returns `{uploadedIndices:[0,1,...]}`.
3. `POST /game-data-patches/:id/chunks/:index`: `{payloadJson:"[...records...]"}`.
4. `POST /game-data-patches/:id/publish`: validates every chunk, counts, hashes and cross-chunk duplicate records before making the release visible.

The manifest is an exact JSON string:
```json
{"schemaVersion":2,"chunks":[{"index":0,"dataType":"JunkItem","hash":"<lowercase SHA-256>","bytes":123,"entryCount":1}]}
```

Each chunk contains a JSON array of records of one data type. Hashes and byte sizes cover the exact UTF-8 chunk text without BOM. The release's `payloadHash` hashes the exact UTF-8 `manifestJson` string, so the existing server/client handshake covers the complete ordered chunk set. Do not reformat or reserialize hashed strings. Chunk strings preserve WZM Int64 values and UnityMultiplayerARPG Int32 values without JavaScript number conversion.

### Download and application

The existing public latest/exact-release routes return metadata and `manifestJson`, with an empty `payloadJson` for version 2. `GET /game-data-patches/:id/chunks/:index` returns `{payloadJson:"..."}`; drafts and their chunks are never public.

Unity validates the manifest before downloading. Each chunk is verified against its size/hash and cached by content hash in `Application.persistentDataPath/GameDataPatches/chunks`. Verified chunks are reused across releases; missing/corrupt chunks are downloaded again. Individual downloads retry up to three attempts. HTTP responses are bounded at 8 MiB. Subscribe to `DataPatchHttp.DownloadProgress(float, string)` for progress UI.

All files must be downloaded and verified before staging begins. Staging reads one chunk at a time instead of assembling a giant payload string. Game data still commits as one transaction. A failed download, invalid record or corrupt chunk leaves the active release unchanged. Staging still holds the game-data overrides and cloned assets in memory; chunking is not a constant-memory game-data loader.

Only exact release IDs may fall back to cached release metadata during an outage. Latest is never guessed. Partial downloads are retained for retry but cannot become active. Cache files are not automatically evicted; remove unused caches only when no patch load/preparation is in progress.

### Limits and compatibility

Version 2 supports 128 MiB total uncompressed JSON, 1024 chunks, 20000 records, a 256 KiB manifest, and 1 MiB per chunk (including a single record). The editor identifies an oversized individual record before uploading. These limits are aligned across both clients and both services. Version 1 keeps its existing 3 MiB payload limit and routes.

Compression is not introduced by this change. Chunking, caching and retries reduce repeated transfers; transfer compression can be configured separately at the reverse proxy.
