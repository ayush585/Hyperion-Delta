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

type CallbackApiName =
  | "writeFile"
  | "appendFile"
  | "rename"
  | "unlink"
  | "rm"
  | "mkdir"
  | "copyFile"
  | "chmod"
  | "utimes";

type FsApiName = SyncApiName | CallbackApiName;

type MutableFsModule = Record<FsApiName, (...args: unknown[]) => unknown>;

export class VfsInterceptor {
  private readonly fsModule = require("node:fs") as MutableFsModule;
  private readonly originals = new Map<FsApiName, (...args: unknown[]) => unknown>();
  private installed = false;

  public constructor(private readonly hooks: VfsInterceptorHooks) {}

  public install(): void {
    if (this.installed) {
      return;
    }

    this.patchSync("writeFileSync", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchSync("appendFileSync", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchSync("renameSync", (args) => [
      { pathLike: args[0], kind: "delete" },
      { pathLike: args[1], kind: "write" },
    ]);
    this.patchSync("unlinkSync", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patchSync("rmSync", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patchSync("mkdirSync", (args) => [
      { pathLike: args[0], kind: "mkdir", fileTypeHint: "directory" },
    ]);
    this.patchSync("copyFileSync", (args) => [
      { pathLike: args[1], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchSync("chmodSync", (args) => [{ pathLike: args[0], kind: "metadata" }]);
    this.patchSync("utimesSync", (args) => [{ pathLike: args[0], kind: "metadata" }]);

    this.patchCallback("writeFile", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchCallback("appendFile", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchCallback("rename", (args) => [
      { pathLike: args[0], kind: "delete" },
      { pathLike: args[1], kind: "write" },
    ]);
    this.patchCallback("unlink", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patchCallback("rm", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patchCallback("mkdir", (args) => [
      { pathLike: args[0], kind: "mkdir", fileTypeHint: "directory" },
    ]);
    this.patchCallback("copyFile", (args) => [
      { pathLike: args[1], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchCallback("chmod", (args) => [{ pathLike: args[0], kind: "metadata" }]);
    this.patchCallback("utimes", (args) => [{ pathLike: args[0], kind: "metadata" }]);

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

  private patchSync(
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

  private patchCallback(
    apiName: CallbackApiName,
    getRecords: (args: unknown[]) => VfsMutationRecord[],
  ): void {
    const original = this.fsModule[apiName];
    this.originals.set(apiName, original);

    this.fsModule[apiName] = (...args: unknown[]) => {
      if (typeof args.at(-1) === "function") {
        this.hooks.beforeMutation(getRecords(args));
      }

      return original.apply(this.fsModule, args);
    };
  }
}
