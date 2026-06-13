import { existsSync, mkdirSync, statSync } from "node:fs";

export interface SessionDeviceInfo {
  workspaceDeviceId: number;
  sessionDeviceId: number;
  sameDevice: boolean;
}

export interface SessionFsAdapter {
  existsSync(path: string): boolean;
  mkdirSync(path: string, options: { recursive: true }): unknown;
  statSync(path: string): { dev: number };
}

const nodeFsAdapter: SessionFsAdapter = {
  existsSync,
  mkdirSync,
  statSync,
};

export function ensureSessionRoot(
  sessionRoot: string,
  fsAdapter: SessionFsAdapter = nodeFsAdapter,
): string {
  if (!fsAdapter.existsSync(sessionRoot)) {
    fsAdapter.mkdirSync(sessionRoot, { recursive: true });
  }

  return sessionRoot;
}

export function probeSessionDeviceInfo(
  workspaceRoot: string,
  sessionRoot: string,
  fsAdapter: SessionFsAdapter = nodeFsAdapter,
): SessionDeviceInfo {
  ensureSessionRoot(sessionRoot, fsAdapter);

  const workspaceDeviceId = fsAdapter.statSync(workspaceRoot).dev;
  const sessionDeviceId = fsAdapter.statSync(sessionRoot).dev;

  return {
    workspaceDeviceId,
    sessionDeviceId,
    sameDevice: workspaceDeviceId === sessionDeviceId,
  };
}
