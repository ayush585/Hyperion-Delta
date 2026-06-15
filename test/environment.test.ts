import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  discoverEnvironmentProfile,
  type EnvironmentProbeAdapter,
  type EnvironmentProfile,
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
});

describe("strategy selector", () => {
  it("selects Tier 3 on Windows", () => {
    const selection = selectStorageStrategy(
      createConfig(),
      createProfile({ platform: "win32", hasRsync: true, sameDeviceForLinks: true }),
    );

    assert.equal(selection.kind, "pure-manifest");
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
