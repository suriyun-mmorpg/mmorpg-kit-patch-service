import { hostname } from "node:os";
import { open, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

interface Owner {
  pid: number;
  hostname?: string;
  token?: string;
  startedAt?: string;
  purpose?: string;
}

function locked(detail: string): Error {
  return new Error("Patch storage is locked. " + detail + " Stop the patch service and verify the owner before manually removing a lock.");
}

async function ownerOf(path: string): Promise<Owner | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  let owner: Owner;
  try {
    owner = JSON.parse(text);
  } catch {
    throw locked("Lock ownership is malformed or still being written.");
  }
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2147483647) {
    throw locked("The lock does not contain a valid owner PID.");
  }
  return owner;
}

function ownerExited(owner: Owner): boolean {
  if (owner.hostname !== undefined && owner.hostname !== hostname()) {
    throw locked("The lock belongs to another host.");
  }
  try {
    // Signal zero checks existence without sending a signal or stopping the process.
    process.kill(owner.pid, 0);
    return false;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ESRCH") return true;
    throw locked("The owner process cannot be checked.");
  }
}

export class WriterLock {
  private released = false;

  constructor(private readonly path: string, private readonly token: string) {}

  async release(): Promise<void> {
    if (this.released) return;
    const owner = await ownerOf(this.path);
    if (owner && owner.token !== this.token) {
      throw locked("Lock ownership changed; another owner's file was not removed.");
    }
    if (owner) await rm(this.path);
    this.released = true;
  }
}

async function createLock(path: string, purpose: string): Promise<WriterLock> {
  const token = crypto.randomUUID();
  const file = await open(path, "wx");
  try {
    await file.writeFile(JSON.stringify({
      pid: process.pid, hostname: hostname(), token, purpose, startedAt: new Date().toISOString(),
    }));
    await file.sync();
  } finally {
    await file.close();
  }
  return new WriterLock(path, token);
}

// Local storage only: PIDs must refer to this host's process namespace.
// The recovery mutex prevents two starters from deleting each other's new writer lock.
export async function acquireWriterLock(root: string, purpose = "service"): Promise<WriterLock> {
  const path = join(root, ".writer.lock");
  const recoveryPath = join(root, ".writer-recovery.lock");
  for (let attempt = 0; attempt < 12; ++attempt) {
    try {
      return await createLock(path, purpose);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const owner = await ownerOf(path);
    if (!owner) continue;
    if (!ownerExited(owner)) throw locked("Owner process " + owner.pid + " is still running.");
    let recovery;
    try {
      recovery = await open(recoveryPath, "wx");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await new Promise(resolve => setTimeout(resolve, 25));
      continue;
    }
    try {
      await recovery.writeFile(JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: new Date().toISOString() }));
      // Re-read inside the mutex. The lock may have been replaced since the first check.
      const current = await ownerOf(path);
      if (current) {
        if (!ownerExited(current)) throw locked("Owner process " + current.pid + " is still running.");
        await rm(path);
        console.warn("Recovered stale patch writer lock from exited process " + current.pid + ".");
      }
      try {
        return await createLock(path, purpose);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    } finally {
      await recovery.close();
      await rm(recoveryPath);
    }
  }
  // Do not automatically delete an interrupted recovery mutex: its ownership is uncertain.
  throw locked("Recovery is in progress or was interrupted. Inspect .writer-recovery.lock before retrying.");
}
