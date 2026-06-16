import {
  constants,
  accessSync,
  existsSync,
  linkSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { randomUUID } from "node:crypto";

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
  windowsVolume?: WindowsVolumeProfile | undefined;
}

export interface WindowsVolumeProfile {
  fileSystemName?: string | undefined;
  isDevDrive: boolean;
  devDriveTrusted: boolean;
  hardLinkCapable: boolean;
  blockCloneCandidate: boolean;
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
  execFileSync(command: "git" | "rsync" | "fsutil", args: readonly string[]): string | void;
}

export interface WindowsHardLinkProbeAdapter {
  mkdirSync(path: string, options: { recursive?: boolean }): void;
  writeFileSync(path: string, data: string): void;
  linkSync(existingPath: string, newPath: string): void;
  rmSync(path: string, options: { force?: boolean; recursive?: boolean }): void;
}

export const nodeEnvironmentProbeAdapter: EnvironmentProbeAdapter = {
  platform: process.platform,
  env: process.env,
  existsSync,
  accessSync,
  readFileSync,
  statSync,
  execFileSync(command, args) {
    return execFileSync(command, [...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  },
};

export const nodeWindowsHardLinkProbeAdapter: WindowsHardLinkProbeAdapter = {
  mkdirSync,
  writeFileSync,
  linkSync,
  rmSync,
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
    windowsVolume: platform === "win32" ? discoverWindowsVolumeProfile(options.workspaceRoot, adapter) : undefined,
  };
}

export function probeWindowsHardLinkCapability(
  sessionRoot: string,
  adapter: WindowsHardLinkProbeAdapter = nodeWindowsHardLinkProbeAdapter,
): boolean {
  const probeDirectory = path.join(sessionRoot, ".windows-link-probe");
  const probeId = randomUUID();
  const sourcePath = path.join(probeDirectory, `${probeId}.source`);
  const linkPath = path.join(probeDirectory, `${probeId}.link`);

  try {
    adapter.mkdirSync(probeDirectory, { recursive: true });
    adapter.writeFileSync(sourcePath, "hyperion-windows-link-probe");
    adapter.linkSync(sourcePath, linkPath);
    return true;
  } catch {
    return false;
  } finally {
    try {
      adapter.rmSync(sourcePath, { force: true });
    } catch {
      // Probe cleanup is best-effort inside Hyperion-owned session storage.
    }

    try {
      adapter.rmSync(linkPath, { force: true });
    } catch {
      // Probe cleanup is best-effort inside Hyperion-owned session storage.
    }

    try {
      adapter.rmSync(probeDirectory, { recursive: true, force: true });
    } catch {
      // Probe cleanup is best-effort inside Hyperion-owned session storage.
    }
  }
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

function discoverWindowsVolumeProfile(
  workspaceRoot: string,
  adapter: EnvironmentProbeAdapter,
): WindowsVolumeProfile {
  const volumePath = getWindowsVolumePath(workspaceRoot);
  const fileSystemName = volumePath ? readWindowsFileSystemName(volumePath, adapter) : undefined;
  const devDriveInfo = volumePath ? readWindowsDevDriveInfo(volumePath, adapter) : {
    isDevDrive: false,
    devDriveTrusted: false,
  };

  return {
    fileSystemName,
    isDevDrive: devDriveInfo.isDevDrive,
    devDriveTrusted: devDriveInfo.devDriveTrusted,
    hardLinkCapable: false,
    blockCloneCandidate: fileSystemName?.toUpperCase() === "REFS",
  };
}

function getWindowsVolumePath(workspaceRoot: string): string | undefined {
  const normalizedRoot = workspaceRoot.replace(/^\\\\\?\\/, "");
  const match = /^([a-zA-Z]:)/.exec(normalizedRoot);
  return match?.[1];
}

function readWindowsFileSystemName(
  volumePath: string,
  adapter: EnvironmentProbeAdapter,
): string | undefined {
  try {
    const output = adapter.execFileSync("fsutil", ["fsinfo", "volumeinfo", volumePath]);

    if (typeof output !== "string") {
      return undefined;
    }

    return /File System Name\s*:\s*([^\r\n]+)/i.exec(output)?.[1]?.trim();
  } catch {
    return undefined;
  }
}

function readWindowsDevDriveInfo(
  volumePath: string,
  adapter: EnvironmentProbeAdapter,
): { isDevDrive: boolean; devDriveTrusted: boolean } {
  try {
    const output = adapter.execFileSync("fsutil", ["devdrv", "query", volumePath]);

    if (typeof output !== "string") {
      return { isDevDrive: false, devDriveTrusted: false };
    }

    const normalized = output.toLowerCase();
    const isDevDrive =
      (normalized.includes("dev drive") || normalized.includes("developer volume")) &&
      !normalized.includes("not a dev drive");
    const devDriveTrusted =
      isDevDrive &&
      (normalized.includes("trusted dev drive") || normalized.includes("trusted developer volume")) &&
      !normalized.includes("not trusted") &&
      !normalized.includes("untrusted");

    return { isDevDrive, devDriveTrusted };
  } catch {
    return { isDevDrive: false, devDriveTrusted: false };
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
