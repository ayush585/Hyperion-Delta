import { createRequire } from "node:module";

import type { DirtyEntry } from "../types.js";

const require = createRequire(import.meta.url);

export type VfsMutationKind = "write" | "delete" | "metadata" | "mkdir";

export interface VfsMutationRecord {
  pathLike: unknown;
  kind: VfsMutationKind;
  fileTypeHint?: DirtyEntry["fileType"];
}

export interface VfsInterceptorHooks {
  beforeMutation(records: VfsMutationRecord[]): void;
}

type SyncApiName =
  | "writeFileSync"
  | "appendFileSync"
  | "renameSync"
  | "unlinkSync"
  | "rmSync"
  | "mkdirSync"
  | "copyFileSync"
  | "chmodSync"
  | "utimesSync";

type MutableFsModule = Record<SyncApiName, (...args: unknown[]) => unknown>;

export class VfsInterceptor {
  private readonly fsModule = require("node:fs") as MutableFsModule;
  private readonly originals = new Map<SyncApiName, (...args: unknown[]) => unknown>();
  private installed = false;

  public constructor(private readonly hooks: VfsInterceptorHooks) {}

  public install(): void {
    if (this.installed) {
      return;
    }

    this.patch("writeFileSync", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patch("appendFileSync", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patch("renameSync", (args) => [
      { pathLike: args[0], kind: "delete" },
      { pathLike: args[1], kind: "write" },
    ]);
    this.patch("unlinkSync", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patch("rmSync", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patch("mkdirSync", (args) => [
      { pathLike: args[0], kind: "mkdir", fileTypeHint: "directory" },
    ]);
    this.patch("copyFileSync", (args) => [
      { pathLike: args[1], kind: "write", fileTypeHint: "file" },
    ]);
    this.patch("chmodSync", (args) => [{ pathLike: args[0], kind: "metadata" }]);
    this.patch("utimesSync", (args) => [{ pathLike: args[0], kind: "metadata" }]);

    this.installed = true;
  }

  public uninstall(): void {
    if (!this.installed) {
      return;
    }

    for (const [apiName, original] of this.originals) {
      this.fsModule[apiName] = original;
    }

    this.originals.clear();
    this.installed = false;
  }

  public get isInstalled(): boolean {
    return this.installed;
  }

  private patch(
    apiName: SyncApiName,
    getRecords: (args: unknown[]) => VfsMutationRecord[],
  ): void {
    const original = this.fsModule[apiName];
    this.originals.set(apiName, original);

    this.fsModule[apiName] = (...args: unknown[]) => {
      this.hooks.beforeMutation(getRecords(args));
      return original.apply(this.fsModule, args);
    };
  }
}
