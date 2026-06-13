import { constants, accessSync, existsSync, readFileSync, statSync } from "node:fs";
import { execFileSync } from "node:child_process";

export type RuntimePlatform = NodeJS.Platform;

export interface EnvironmentProfile {
  platform: RuntimePlatform;
  isWsl2: boolean;
  hasDevShm: boolean;
  devShmWritable: boolean;
  hasRsync: boolean;
  gitAvailable: boolean;
  sameDeviceForLinks: boolean;
  caseSensitive: boolean;
}

export interface EnvironmentProbeOptions {
  workspaceRoot: string;
  sessionRoot: string;
}

export interface EnvironmentProbeAdapter {
  platform: RuntimePlatform;
  env: NodeJS.ProcessEnv;
  existsSync(path: string): boolean;
  accessSync(path: string, mode: number): void;
  readFileSync(path: string, encoding: BufferEncoding): string;
  statSync(path: string): { dev: number };
  execFileSync(command: string, args: readonly string[]): void;
}

export const nodeEnvironmentProbeAdapter: EnvironmentProbeAdapter = {
  platform: process.platform,
  env: process.env,
  existsSync,
  accessSync,
  readFileSync,
  statSync,
  execFileSync(command, args): void {
    execFileSync(command, [...args], { stdio: "ignore" });
  },
};

export function discoverEnvironmentProfile(
  options: EnvironmentProbeOptions,
  adapter: EnvironmentProbeAdapter = nodeEnvironmentProbeAdapter,
): EnvironmentProfile {
  const platform = adapter.platform;
  const hasDevShm = platform === "linux" && safeExists("/dev/shm", adapter);
  const devShmWritable = hasDevShm && safeWritable("/dev/shm", adapter);

  return {
    platform,
    isWsl2: detectWsl2(adapter),
    hasDevShm,
    devShmWritable,
    hasRsync: commandAvailable("rsync", adapter),
    gitAvailable: commandAvailable("git", adapter),
    sameDeviceForLinks: detectSameDevice(options.workspaceRoot, options.sessionRoot, adapter),
    caseSensitive: inferCaseSensitivity(platform),
  };
}

function detectWsl2(adapter: EnvironmentProbeAdapter): boolean {
  if (adapter.platform !== "linux") {
    return false;
  }

  if (adapter.env.WSL_DISTRO_NAME || adapter.env.WSL_INTEROP) {
    return true;
  }

  try {
    const procVersion = adapter.readFileSync("/proc/version", "utf8").toLowerCase();
    return procVersion.includes("microsoft") || procVersion.includes("wsl");
  } catch {
    return false;
  }
}

function commandAvailable(command: "git" | "rsync", adapter: EnvironmentProbeAdapter): boolean {
  try {
    adapter.execFileSync(command, ["--version"]);
    return true;
  } catch {
    return false;
  }
}

function detectSameDevice(
  workspaceRoot: string,
  sessionRoot: string,
  adapter: EnvironmentProbeAdapter,
): boolean {
  try {
    if (!adapter.existsSync(sessionRoot)) {
      return false;
    }

    return adapter.statSync(workspaceRoot).dev === adapter.statSync(sessionRoot).dev;
  } catch {
    return false;
  }
}

function safeExists(path: string, adapter: EnvironmentProbeAdapter): boolean {
  try {
    return adapter.existsSync(path);
  } catch {
    return false;
  }
}

function safeWritable(path: string, adapter: EnvironmentProbeAdapter): boolean {
  try {
    adapter.accessSync(path, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

function inferCaseSensitivity(platform: RuntimePlatform): boolean {
  return platform === "linux";
}
