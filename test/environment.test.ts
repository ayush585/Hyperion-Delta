import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  discoverEnvironmentProfile,
  probeWindowsHardLinkCapability,
  type EnvironmentProbeAdapter,
  type EnvironmentProfile,
  type WindowsHardLinkProbeAdapter,
} from "../src/internal/environment.js";
import { selectStorageStrategy } from "../src/internal/strategy.js";
import type { ResolvedHyperionConfig } from "../src/types.js";

function createAdapter(
  overrides: Partial<EnvironmentProbeAdapter> = {},
): EnvironmentProbeAdapter {
  const existingPaths = new Set(["workspace", "session"]);
  const commandSet = new Set(["git", "rsync"]);

  return {
    platform: "linux",
    env: {},
    existsSync: (path) => existingPaths.has(path),
    accessSync: () => undefined,
    readFileSync: () => "Linux version 6.6.0",
    statSync: (path) => ({ dev: path === "workspace" ? 10 : 10 }),
    execFileSync: (command) => {
      if (!commandSet.has(command)) {
        throw new Error(`missing command: ${command}`);
      }
    },
    ...overrides,
  };
}

function createConfig(overrides: Partial<ResolvedHyperionConfig> = {}): ResolvedHyperionConfig {
  return {
    workspaceRoot: "workspace",
    useTmpfs: true,
    ignoredPatterns: [],
    overrideDefaultIgnores: false,
    enableFsInterceptor: true,
    maxConcurrentCheckpoints: 64,
    sessionRoot: "session",
    useHotBuffer: true,
    hotBufferMaxFileBytes: 256 * 1024,
    hotBufferMaxTotalBytes: 8 * 1024 * 1024,
    hotBufferMaxFiles: 1024,
    strictIgnoredWrites: false,
    durableAttemptJournals: true,
    ...overrides,
  };
}

function createProfile(overrides: Partial<EnvironmentProfile> = {}): EnvironmentProfile {
  return {
    platform: "linux",
    isWsl2: false,
    hasDevShm: false,
    devShmWritable: false,
    hasRsync: true,
    gitAvailable: true,
    sameDeviceForLinks: true,
    caseSensitive: true,
    ...overrides,
  };
}

describe("environment discovery", () => {
  it("detects Linux tmpfs capability and command availability", () => {
    const profile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({
        existsSync: (path) => path === "/dev/shm" || path === "session",
      }),
    );

    assert.equal(profile.platform, "linux");
    assert.equal(profile.hasDevShm, true);
    assert.equal(profile.devShmWritable, true);
    assert.equal(profile.hasRsync, true);
    assert.equal(profile.gitAvailable, true);
    assert.equal(profile.sameDeviceForLinks, true);
    assert.equal(profile.caseSensitive, true);
  });

  it("detects WSL2 through environment variables and /proc/version", () => {
    const envProfile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({ env: { WSL_DISTRO_NAME: "Ubuntu" } }),
    );
    const procProfile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({ readFileSync: () => "Linux version 6.6.0-microsoft-standard-WSL2" }),
    );

    assert.equal(envProfile.isWsl2, true);
    assert.equal(procProfile.isWsl2, true);
  });

  it("degrades conservatively when probes fail or session root is absent", () => {
    const profile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({
        existsSync: (path) => path !== "/dev/shm" && path !== "session",
        accessSync: () => {
          throw new Error("not writable");
        },
        readFileSync: () => {
          throw new Error("missing proc version");
        },
        statSync: () => {
          throw new Error("missing stat");
        },
        execFileSync: () => {
          throw new Error("missing command");
        },
      }),
    );

    assert.equal(profile.hasDevShm, false);
    assert.equal(profile.devShmWritable, false);
    assert.equal(profile.hasRsync, false);
    assert.equal(profile.gitAvailable, false);
    assert.equal(profile.sameDeviceForLinks, false);
  });

  it("detects cross-device link risk when device IDs differ", () => {
    const profile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({
        statSync: (path) => ({ dev: path === "workspace" ? 10 : 20 }),
      }),
    );

    assert.equal(profile.sameDeviceForLinks, false);
  });

  it("reports deterministic case-sensitivity defaults by platform", () => {
    const windowsProfile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({ platform: "win32" }),
    );
    const linuxProfile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({ platform: "linux" }),
    );

    assert.equal(windowsProfile.caseSensitive, false);
    assert.equal(linuxProfile.caseSensitive, true);
  });

  it("discovers Windows NTFS, ReFS, and Dev Drive volume signals", () => {
    const ntfsProfile = discoverEnvironmentProfile(
      { workspaceRoot: "C:\\repo", sessionRoot: "C:\\repo\\.hyperion\\checkpoints" },
      createAdapter({
        platform: "win32",
        execFileSync(command, args) {
          if (command === "fsutil" && args.join(" ") === "fsinfo volumeinfo C:") {
            return "Volume Name : Dev\nFile System Name : NTFS\n";
          }

          if (command === "fsutil" && args.join(" ") === "devdrv query C:") {
            return "This is a trusted developer volume";
          }

          return undefined;
        },
      }),
    );
    const refsProfile = discoverEnvironmentProfile(
      { workspaceRoot: "D:\\repo", sessionRoot: "D:\\repo\\.hyperion\\checkpoints" },
      createAdapter({
        platform: "win32",
        execFileSync(command, args) {
          if (command === "fsutil" && args.join(" ") === "fsinfo volumeinfo D:") {
            return "File System Name : ReFS\n";
          }

          if (command === "fsutil" && args.join(" ") === "devdrv query D:") {
            return "This is not a dev drive";
          }

          return undefined;
        },
      }),
    );

    assert.equal(ntfsProfile.windowsVolume?.fileSystemName, "NTFS");
    assert.equal(ntfsProfile.windowsVolume?.isDevDrive, true);
    assert.equal(ntfsProfile.windowsVolume?.devDriveTrusted, true);
    assert.equal(ntfsProfile.windowsVolume?.hardLinkCapable, false);
    assert.equal(ntfsProfile.windowsVolume?.blockCloneCandidate, false);
    assert.equal(refsProfile.windowsVolume?.fileSystemName, "ReFS");
    assert.equal(refsProfile.windowsVolume?.isDevDrive, false);
    assert.equal(refsProfile.windowsVolume?.blockCloneCandidate, true);
  });

  it("degrades Windows volume discovery when fsutil is unavailable", () => {
    const profile = discoverEnvironmentProfile(
      { workspaceRoot: "C:\\repo", sessionRoot: "C:\\repo\\.hyperion\\checkpoints" },
      createAdapter({
        platform: "win32",
        execFileSync() {
          throw new Error("fsutil unavailable");
        },
      }),
    );

    assert.equal(profile.windowsVolume?.fileSystemName, undefined);
    assert.equal(profile.windowsVolume?.isDevDrive, false);
    assert.equal(profile.windowsVolume?.devDriveTrusted, false);
    assert.equal(profile.windowsVolume?.hardLinkCapable, false);
    assert.equal(profile.windowsVolume?.blockCloneCandidate, false);
  });

  it("probes Windows hard-link capability inside Hyperion-owned storage", () => {
    const calls: string[] = [];
    const adapter: WindowsHardLinkProbeAdapter = {
      mkdirSync(path) {
        calls.push(`mkdir:${path}`);
      },
      writeFileSync(path) {
        calls.push(`write:${path}`);
      },
      linkSync(source, target) {
        calls.push(`link:${source}->${target}`);
      },
      rmSync(path) {
        calls.push(`rm:${path}`);
      },
    };

    assert.equal(probeWindowsHardLinkCapability("C:\\repo\\.hyperion\\checkpoints", adapter), true);
    assert.equal(calls.some((call) => call.startsWith("link:")), true);
    assert.equal(calls.filter((call) => call.startsWith("rm:")).length, 3);
  });

  it("reports failed Windows hard-link probes conservatively", () => {
    const adapter: WindowsHardLinkProbeAdapter = {
      mkdirSync() {},
      writeFileSync() {},
      linkSync() {
        throw new Error("links disabled");
      },
      rmSync() {},
    };

    assert.equal(probeWindowsHardLinkCapability("C:\\repo\\.hyperion\\checkpoints", adapter), false);
  });
});

describe("strategy selector", () => {
  it("selects Tier 3 on Windows without verified native links", () => {
    const selection = selectStorageStrategy(
      createConfig(),
      createProfile({ platform: "win32", hasRsync: true, sameDeviceForLinks: true }),
    );

    assert.equal(selection.kind, "pure-manifest");
  });

  it("selects NTFS link storage on Windows when hard links are verified", () => {
    const selection = selectStorageStrategy(
      createConfig(),
      createProfile({
        platform: "win32",
        sameDeviceForLinks: true,
        windowsVolume: {
          fileSystemName: "NTFS",
          isDevDrive: false,
          devDriveTrusted: false,
          hardLinkCapable: true,
          blockCloneCandidate: false,
        },
      }),
    );

    assert.equal(selection.kind, "ntfs-link");
    assert.equal(selection.reason, "ntfs-links-available");
  });

  it("keeps ReFS and Dev Drive on Pure Manifest until block clone is implemented", () => {
    const refsSelection = selectStorageStrategy(
      createConfig(),
      createProfile({
        platform: "win32",
        sameDeviceForLinks: true,
        windowsVolume: {
          fileSystemName: "ReFS",
          isDevDrive: true,
          devDriveTrusted: true,
          hardLinkCapable: false,
          blockCloneCandidate: true,
        },
      }),
    );
    const crossDeviceSelection = selectStorageStrategy(
      createConfig(),
      createProfile({
        platform: "win32",
        sameDeviceForLinks: false,
        windowsVolume: {
          fileSystemName: "NTFS",
          isDevDrive: false,
          devDriveTrusted: false,
          hardLinkCapable: true,
          blockCloneCandidate: false,
        },
      }),
    );

    assert.equal(refsSelection.kind, "pure-manifest");
    assert.equal(refsSelection.reason, "windows-block-clone-unimplemented");
    assert.equal(crossDeviceSelection.kind, "pure-manifest");
    assert.equal(crossDeviceSelection.reason, "cross-device-link-risk");
  });

  it("selects Tier 1 when Linux tmpfs is usable", () => {
    const selection = selectStorageStrategy(
      createConfig(),
      createProfile({
        platform: "linux",
        hasDevShm: true,
        devShmWritable: true,
        hasRsync: true,
        sameDeviceForLinks: true,
      }),
    );

    assert.equal(selection.kind, "tmpfs");
  });

  it("lets Tier 1 win over Tier 2", () => {
    const selection = selectStorageStrategy(
      createConfig(),
      createProfile({
        platform: "linux",
        hasDevShm: true,
        devShmWritable: true,
        hasRsync: true,
        sameDeviceForLinks: true,
      }),
    );

    assert.equal(selection.kind, "tmpfs");
    assert.equal(selection.reason, "tmpfs-available");
  });

  it("selects Tier 2 on Linux or macOS when links are safe", () => {
    const linuxSelection = selectStorageStrategy(
      createConfig({ useTmpfs: false }),
      createProfile({ platform: "linux", hasRsync: true, sameDeviceForLinks: true }),
    );
    const macSelection = selectStorageStrategy(
      createConfig(),
      createProfile({ platform: "darwin", hasRsync: true, sameDeviceForLinks: true }),
    );

    assert.equal(linuxSelection.kind, "posix-link");
    assert.equal(macSelection.kind, "posix-link");
  });

  it("skips Tier 2 when device IDs differ or are unknown", () => {
    const crossDevice = selectStorageStrategy(
      createConfig({ useTmpfs: false }),
      createProfile({ platform: "linux", hasRsync: true, sameDeviceForLinks: false }),
    );
    const missingSessionRootProfile = discoverEnvironmentProfile(
      { workspaceRoot: "workspace", sessionRoot: "session" },
      createAdapter({
        platform: "darwin",
        existsSync: (path) => path !== "session",
      }),
    );
    const missingSessionRoot = selectStorageStrategy(createConfig(), missingSessionRootProfile);

    assert.equal(crossDevice.kind, "pure-manifest");
    assert.equal(crossDevice.reason, "cross-device-link-risk");
    assert.equal(missingSessionRoot.kind, "pure-manifest");
  });

  it("falls back to Tier 3 when rsync is unavailable", () => {
    const selection = selectStorageStrategy(
      createConfig({ useTmpfs: false }),
      createProfile({ platform: "linux", hasRsync: false, sameDeviceForLinks: true }),
    );

    assert.equal(selection.kind, "pure-manifest");
    assert.equal(selection.reason, "rsync-unavailable");
  });
});
