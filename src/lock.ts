import { randomBytes } from "node:crypto";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

export class LockError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LockError";
  }
}

export interface FileLock {
  /** Pushes the expiry forward; call it periodically while the lock is held. */
  refresh(): void;
  release(): void;
}

/**
 * Advisory lock backed by an exclusively created file (`wx`) holding an owner token and an expiry.
 * An expired lock (its owner crashed) is removed and taken over. This protects against two
 * cooperating processes on one local file system; the check-then-remove step for an expired lock
 * is not atomic, and it gives no guarantee on network file systems.
 */
export function acquireFileLock(path: string, ttlMs: number, now: () => number = Date.now): FileLock {
  const token = randomBytes(8).toString("hex");
  const write = (flag: "wx" | "w") =>
    writeFileSync(path, JSON.stringify({ token, expiresAt: now() + ttlMs }), { flag, mode: 0o600 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      write("wx");
      return {
        refresh() {
          if (ownerOf(path) === token) write("w");
        },
        release() {
          if (ownerOf(path) === token) {
            try {
              unlinkSync(path);
            } catch {
              // already gone
            }
          }
        },
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      const held = readLock(path);
      if (held && held.expiresAt > now()) throw new LockError(`locked: ${path}`);
      try {
        unlinkSync(path);
      } catch {
        // someone else removed it first; retry the exclusive create
      }
    }
  }
  throw new LockError(`could not acquire lock: ${path}`);
}

function readLock(path: string): { token: string; expiresAt: number } | undefined {
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as { token?: unknown; expiresAt?: unknown };
    if (typeof parsed.token === "string" && typeof parsed.expiresAt === "number") return { token: parsed.token, expiresAt: parsed.expiresAt };
  } catch {
    // missing or unreadable: treated as not held
  }
  return undefined;
}

function ownerOf(path: string): string | undefined {
  return readLock(path)?.token;
}
