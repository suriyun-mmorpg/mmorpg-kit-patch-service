# Database-only patch streams

PatchDatabaseId identifies one independent patch stream. Settings, upload envelopes, release metadata, latest queries, client/server synchronization, and cached release metadata no longer contain Environment.

Use separate IDs such as `main` and `test` when separate histories are needed. Each ID has its own latest published release and version counter. Release IDs stay globally unique. The service URL still selects the deployment. Enabled profiles always load latest at startup; the connection handshake still selects the server's exact release ID and hash.

## Coordinated rollout

Upgrade both Unity clients, both servers, and their corresponding services together. The patch-state network message no longer writes the environment string; mixed client/server builds are unsupported. Both services reject requests containing an old `environment` field/query with HTTP 400, rather than guessing a scope.

Set profiles to the intended migrated database IDs. Unity release metadata cache keys now use database ID and release ID; old environment-based metadata caches are not reused. Content-addressed chunk caches remain reusable. Startup requires a fresh latest query; exact-release offline fallback still uses verified metadata cached by the updated client.

## Standalone Bun service

The new published layout is `databases/<databaseId>/versions/<version>-<releaseId>/`. Legacy folders or draft metadata containing Environment cause startup to fail with a migration message. No history is silently skipped or merged.

Stop the old service and back up its storage. Edit `examples/scope-map.json` so every old scope maps to a unique target database ID. For example:

```json
[
  { "databaseId": "1", "environment": "staging", "targetDatabaseId": "1" },
  { "databaseId": "1", "environment": "production", "targetDatabaseId": "1-live" }
]
```

Run from `mmorpg-kit-patch-service`:

```powershell
bun scripts/migrate-patch-scopes.ts ./data ./data-database-only ./examples/scope-map.json
bun scripts/migrate-patch-scopes.ts ./data ./data-database-only ./examples/scope-map.json --apply
```

The first command is a dry run. The second copies verified records to a new destination that must not already exist. Both acquire the source writer lock to prevent a concurrent service writer. Missing mappings, duplicate target IDs, bad hashes, and conflicting histories fail before copying.

The original data folders remain unchanged. The destination preserves release IDs, versions, timestamps, payload/manifest hashes, exact numeric bytes, and uploaded chunks of incomplete drafts. Only metadata scope and folder layout change. Final verification opens the destination with the new store. If copying fails, retain the original source and use a new destination path for retry.

After success, point `PATCH_DATA_DIR` to the new folder, restart the updated service, and retain the old folder as backup. Health reports version `2.0.0`. Update profiles to the mapped IDs.

## WZX PostgreSQL service

Migration `20261010000000_database_only_patch_scope` removes the Environment column and makes `(database_id, version)` unique. Existing release IDs, versions, entries, chunks and hashes stay intact.

If every database ID has only one legacy environment, the migration preserves those database IDs directly. If an ID has multiple environments, the migration stops before changing data.

For multiple environments, stop service writers and back up the database. Inspect:

```sql
SELECT database_id, environment, COUNT(*)
FROM game_data_patches GROUP BY database_id, environment;
```

Edit the JSON mapping inside `scripts/remap-patch-scopes.sql` to cover every existing scope with a unique target ID. Run it against the intended database before deploying the schema migration. The script validates the complete map and applies database-ID changes in one locked transaction; temporary IDs permit swaps without unique-index conflicts. It does not change release IDs, versions or hashed content.

Then run the normal `prisma migrate deploy`, `prisma generate`, service build and restart. A failed guarded migration may need `prisma migrate resolve --rolled-back 20261010000000_database_only_patch_scope` before retrying, following the usual deployment procedure.

No migration or storage conversion is applied to live data by this implementation. Update clients' profiles and deploy the services before using the new protocol.
