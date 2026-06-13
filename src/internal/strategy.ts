import type { ResolvedHyperionConfig, StorageStrategyKind } from "../types.js";
import type { EnvironmentProfile } from "./environment.js";

export type StrategySelectionReason =
  | "tmpfs-available"
  | "posix-links-available"
  | "tmpfs-disabled"
  | "tmpfs-unavailable"
  | "cross-device-link-risk"
  | "rsync-unavailable"
  | "unsupported-platform";

export interface StrategySelection {
  kind: StorageStrategyKind;
  reason: StrategySelectionReason;
}

export function selectStorageStrategy(
  config: ResolvedHyperionConfig,
  profile: EnvironmentProfile,
): StrategySelection {
  if (profile.platform === "linux" || profile.platform === "darwin") {
    if (profile.platform === "linux" && config.useTmpfs && profile.hasDevShm && profile.devShmWritable) {
      return { kind: "tmpfs", reason: "tmpfs-available" };
    }

    if (profile.hasRsync && profile.sameDeviceForLinks) {
      return { kind: "posix-link", reason: "posix-links-available" };
    }

    if (!profile.hasRsync) {
      return { kind: "pure-manifest", reason: "rsync-unavailable" };
    }

    return { kind: "pure-manifest", reason: "cross-device-link-risk" };
  }

  return {
    kind: "pure-manifest",
    reason: config.useTmpfs ? "unsupported-platform" : "tmpfs-disabled",
  };
}
