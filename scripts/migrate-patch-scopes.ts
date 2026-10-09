import { readFile } from "node:fs/promises";
import { migrateScopes } from "../src/migrate-scopes";

const args = Bun.argv.slice(2);
const apply = args.at(-1) === "--apply";
const paths = apply ? args.slice(0, -1) : args;
if (paths.length !== 3) {
  throw new Error("Usage: bun scripts/migrate-patch-scopes.ts <old-data> <new-data> <scope-map.json> [--apply]");
}
const [source, destination, map] = paths as [string, string, string];
const plan = await migrateScopes(source, destination, JSON.parse(await readFile(map, "utf8")), apply);
console.log(JSON.stringify(plan, null, 2));
console.log(apply ? "Migration verified. Point PATCH_DATA_DIR at the new directory; retain the old directory as backup." : "Dry run only. Review the map and rerun with --apply.");
