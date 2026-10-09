import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { acquireWriterLock } from "../src/writer-lock";

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "patch-writer-lock-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function exitedPid(): Promise<number> {
  const child = Bun.spawn([process.execPath, "-e", "process.exit(0)"], { stdout: "ignore", stderr: "ignore" });
  await child.exited;
  expect(() => process.kill(child.pid, 0)).toThrow();
  return child.pid;
}

test("active owner cannot be replaced, and close releases its own lock", async () => {
  const lock = await acquireWriterLock(root);
  const before = await readFile(join(root, ".writer.lock"), "utf8");
  await expect(acquireWriterLock(root)).rejects.toThrow("still running");
  expect(await readFile(join(root, ".writer.lock"), "utf8")).toBe(before);
  await lock.release();
  await lock.release();
  const next = await acquireWriterLock(root);
  await next.release();
});

test("a confirmed exited owner's legacy lock is recovered automatically", async () => {
  const pid = await exitedPid();
  await writeFile(join(root, ".writer.lock"), JSON.stringify({ pid, startedAt: "2026-10-09T00:00:00Z" }));
  const lock = await acquireWriterLock(root);
  expect(JSON.parse(await readFile(join(root, ".writer.lock"), "utf8")).pid).toBe(process.pid);
  await expect(stat(join(root, ".writer-recovery.lock"))).rejects.toThrow();
  await lock.release();
});

test("simultaneous startups reclaim one stale lock without admitting two writers", async () => {
  const pid = await exitedPid();
  await writeFile(join(root, ".writer.lock"), JSON.stringify({ pid, hostname: hostname() }));
  const results = await Promise.allSettled(Array.from({ length: 12 }, () => acquireWriterLock(root)));
  const winners = results.filter(result => result.status === "fulfilled");
  expect(winners).toHaveLength(1);
  const winner = winners[0] as PromiseFulfilledResult<Awaited<ReturnType<typeof acquireWriterLock>>>;
  const owner = JSON.parse(await readFile(join(root, ".writer.lock"), "utf8"));
  expect(owner.pid).toBe(process.pid);
  await winner.value.release();
});

test("malformed, invalid and foreign-host locks are retained for inspection", async () => {
  for (const text of ["", "{broken", JSON.stringify({ pid: -1 }), JSON.stringify({ pid: process.pid, hostname: "a-different-host" })]) {
    await writeFile(join(root, ".writer.lock"), text);
    await expect(acquireWriterLock(root)).rejects.toThrow("locked");
    expect(await readFile(join(root, ".writer.lock"), "utf8")).toBe(text);
  }
});

test("old owner cannot remove another owner's replacement lock", async () => {
  const lock = await acquireWriterLock(root);
  const replacement = JSON.stringify({ pid: process.pid, token: "replacement" });
  await writeFile(join(root, ".writer.lock"), replacement);
  await expect(lock.release()).rejects.toThrow("ownership changed");
  expect(await readFile(join(root, ".writer.lock"), "utf8")).toBe(replacement);
});

test("interrupted recovery mutex is not blindly deleted", async () => {
  const pid = await exitedPid();
  const stale = JSON.stringify({ pid });
  await writeFile(join(root, ".writer.lock"), stale);
  await writeFile(join(root, ".writer-recovery.lock"), "unknown recovery owner");
  await expect(acquireWriterLock(root)).rejects.toThrow("Recovery is in progress or was interrupted");
  expect(await readFile(join(root, ".writer.lock"), "utf8")).toBe(stale);
  expect(await readFile(join(root, ".writer-recovery.lock"), "utf8")).toBe("unknown recovery owner");
});
