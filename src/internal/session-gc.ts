import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
  type Dirent,
} from "node:fs";
import { hostname } from "node:os";
import path from "node:path";

import { isPathInsideRoot, toPosixPath } from "./path.js";

export const STALE_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
const SDK_PACKAGE_VERSION = "0.1.6";
const SESSION_PREFIX = "session-";
const LOCK_FILE_NAME = "lock.json";

export interface SessionLockfile {
  pid: number;
  hostname: string;
  createdAt: number;
  sessionId: string;
  sdkVersion?: string;
}

export interface SessionGcAdapter {
  readonly pid: number;
  existsSync(targetPath: string): boolean;
  mkdirSync(targetPath: string, options: { recursive: true }): void;
  readdirSync(targetPath: string, options: { withFileTypes: true }): Dirent[];
  readFileSync(targetPath: string, encoding: BufferEncoding): string;
  writeFileSync(targetPath: string, data: string, encoding: BufferEncoding): void;
  statSync(targetPath: string): { mtimeMs: number };
  chmodSync(targetPath: string, mode: number): void;
  rmSync(targetPath: string, options: { recursive?: boolean; force?: boolean }): void;
  hostname(): string;
  now(): number;
  isProcessAlive(pid: number): boolean;
}

export interface SessionManagerOptions {
  workspaceRoot: string;
  sessionId: string;
  shouldSkipWorkspacePath?: (relativePath: string) => boolean;
  adapter?: SessionGcAdapter;
}

const nodeSessionGcAdapter: SessionGcAdapter = {
  pid: process.pid,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  statSync,
  chmodSync,
  rmSync,
  hostname,
  now: Date.now,
  isProcessAlive(pid): boolean {
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }

    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "EPERM";
    }
  },
};

let defaultSessionGcAdapter = nodeSessionGcAdapter;

export function setDefaultSessionGcAdapterForTests(adapter: SessionGcAdapter | undefined): void {
  defaultSessionGcAdapter = adapter ?? nodeSessionGcAdapter;
}

export class HyperionSessionManager {
  public readonly hyperionRoot: string;
  public readonly sessionDir: string;
  public readonly lockfilePath: string;

  private readonly workspaceRoot: string;
  private readonly sessionId: string;
  private readonly shouldSkipWorkspacePath: (relativePath: string) => boolean;
  private readonly adapter: SessionGcAdapter;

  public constructor(options: SessionManagerOptions) {
    this.workspaceRoot = path.resolve(options.workspaceRoot);
    this.sessionId = options.sessionId;
    this.shouldSkipWorkspacePath = options.shouldSkipWorkspacePath ?? (() => false);
    this.adapter = options.adapter ?? defaultSessionGcAdapter;
    this.hyperionRoot = path.join(this.workspaceRoot, ".hyperion");
    this.sessionDir = path.join(this.hyperionRoot, `${SESSION_PREFIX}${this.sessionId}`);
    this.lockfilePath = path.join(this.sessionDir, LOCK_FILE_NAME);
  }

  public initialize(): void {
    this.runStartupGarbageCollection();
    this.adapter.mkdirSync(this.sessionDir, { recursive: true });
    this.adapter.writeFileSync(
      this.lockfilePath,
      `${JSON.stringify(this.createLockfile(), null, 2)}\n`,
      "utf8",
    );
  }

  public cleanupCurrentSession(): void {
    this.removeSessionDirectory(this.sessionDir);
  }

  public runStartupGarbageCollection(): void {
    this.removeStaleSessionDirectories();
    this.removeAbandonedTempFiles();
  }

  private removeStaleSessionDirectories(): void {
    if (!this.adapter.existsSync(this.hyperionRoot)) {
      return;
    }

    for (const entry of this.safeReadDirectory(this.hyperionRoot)) {
      if (!entry.isDirectory() || !entry.name.startsWith(SESSION_PREFIX)) {
        continue;
      }

      const sessionDir = path.join(this.hyperionRoot, entry.name);

      if (this.shouldRemoveSessionDirectory(sessionDir)) {
        this.removeSessionDirectory(sessionDir);
      }
    }
  }

  private shouldRemoveSessionDirectory(sessionDir: string): boolean {
    const lockfile = this.readLockfile(path.join(sessionDir, LOCK_FILE_NAME));

    if (lockfile) {
      return !this.adapter.isProcessAlive(lockfile.pid);
    }

    try {
      return this.adapter.now() - this.adapter.statSync(sessionDir).mtimeMs > STALE_SESSION_TTL_MS;
    } catch {
      return false;
    }
  }

  private removeAbandonedTempFiles(): void {
    this.removeAbandonedTempFilesInDirectory(this.workspaceRoot);
  }

  private removeAbandonedTempFilesInDirectory(directoryPath: string): void {
    for (const entry of this.safeReadDirectory(directoryPath)) {
      const entryPath = path.join(directoryPath, entry.name);
      const relativePath = toPosixPath(path.relative(this.workspaceRoot, entryPath));

      if (entry.isDirectory()) {
        if (this.shouldSkipWorkspacePath(relativePath)) {
          continue;
        }

        this.removeAbandonedTempFilesInDirectory(entryPath);
        continue;
      }

      if (entry.isFile() && isHyperionTempFileName(entry.name)) {
        try {
          this.adapter.rmSync(entryPath, { force: true });
        } catch {
          // Startup cleanup is best-effort.
        }
      }
    }
  }

  private removeSessionDirectory(sessionDir: string): void {
    if (!this.isOwnedSessionDirectory(sessionDir)) {
      return;
    }

    try {
      this.restoreWritablePermissions(sessionDir);
      this.adapter.rmSync(sessionDir, { recursive: true, force: true });
    } catch {
      // Session GC is best-effort and must not block workspace startup or exit.
    }
  }

  private restoreWritablePermissions(targetPath: string): void {
    try {
      this.adapter.chmodSync(targetPath, 0o700);
    } catch {
      return;
    }

    for (const entry of this.safeReadDirectory(targetPath)) {
      const entryPath = path.join(targetPath, entry.name);

      try {
        this.adapter.chmodSync(entryPath, 0o700);
      } catch {
        // Continue best-effort permission restoration.
      }

      if (entry.isDirectory()) {
        this.restoreWritablePermissions(entryPath);
      }
    }
  }

  private isOwnedSessionDirectory(sessionDir: string): boolean {
    return (
      path.basename(sessionDir).startsWith(SESSION_PREFIX) &&
      sessionDir !== this.hyperionRoot &&
      isPathInsideRoot(this.hyperionRoot, sessionDir)
    );
  }

  private safeReadDirectory(directoryPath: string): Dirent[] {
    try {
      return this.adapter.readdirSync(directoryPath, { withFileTypes: true });
    } catch {
      return [];
    }
  }

  private readLockfile(lockfilePath: string): SessionLockfile | undefined {
    try {
      const parsed = JSON.parse(this.adapter.readFileSync(lockfilePath, "utf8")) as unknown;
      return isSessionLockfile(parsed) ? parsed : undefined;
    } catch {
      return undefined;
    }
  }

  private createLockfile(): SessionLockfile {
    return {
      pid: this.adapter.pid,
      hostname: this.adapter.hostname(),
      createdAt: this.adapter.now(),
      sessionId: this.sessionId,
      sdkVersion: SDK_PACKAGE_VERSION,
    };
  }
}

function isSessionLockfile(value: unknown): value is SessionLockfile {
  if (!value || typeof value !== "object") {
    return false;
  }

  const candidate = value as Partial<SessionLockfile>;

  return (
    typeof candidate.pid === "number" &&
    typeof candidate.hostname === "string" &&
    typeof candidate.createdAt === "number" &&
    typeof candidate.sessionId === "string"
  );
}

function isHyperionTempFileName(fileName: string): boolean {
  return fileName.startsWith(".hyperion-") && fileName.endsWith(".tmp");
}
