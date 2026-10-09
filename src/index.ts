import { createApp } from "./app";
import { PatchStore } from "./store";

const secrets = (Bun.env.PATCH_UPLOAD_SECRET_KEYS ?? "").split(",").map(key => key.trim()).filter(Boolean);
if (!secrets.length || secrets.some(key => key.length < 32)) {
  throw new Error("Set PATCH_UPLOAD_SECRET_KEYS to a random key of at least 32 characters (see .env.example).");
}
const port = Number(Bun.env.PORT ?? 3000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
const store = await PatchStore.open(Bun.env.PATCH_DATA_DIR ?? "./data");
const app = createApp(store, secrets);
try {
  app.listen({ hostname: Bun.env.HOST ?? "127.0.0.1", port });
} catch (error) {
  await store.close();
  throw error;
}
console.log(`Patch service listening on ${app.server?.url}; storage: ${store.root}`);
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  await app.stop();
  await store.close();
}
process.on("SIGINT", () => void shutdown());
process.on("SIGTERM", () => void shutdown());
