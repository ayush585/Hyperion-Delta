import { createRequire } from "node:module";

import type { DirtyEntry, VfsMutationKind } from "../types.js";

const require = createRequire(import.meta.url);
const streamSuppressionOwners = new WeakSet<object>();

export interface VfsMutationRecord {
  pathLike: unknown;
  kind: VfsMutationKind;
  fileTypeHint?: DirtyEntry["fileType"];
}

export interface VfsInterceptorHooks {
  beforeMutation(records: VfsMutationRecord[]): void;
  mutationFailed?(records: VfsMutationRecord[]): void;
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
  | "write"
  | "writev"
  | "truncate"
  | "symlink"
  | "link"
  | "fchmod"
  | "futimes"
  | "rename"
  | "unlink"
  | "rm"
  | "mkdir"
  | "copyFile"
  | "chmod"
  | "utimes";

type FsApiName = SyncApiName | CallbackApiName;
type StreamApiName = "createWriteStream";
type WritableFsApiName = FsApiName | StreamApiName;

type PromiseApiName =
  | "writeFile"
  | "appendFile"
  | "truncate"
  | "symlink"
  | "link"
  | "rename"
  | "unlink"
  | "rm"
  | "mkdir"
  | "copyFile"
  | "chmod"
  | "utimes";
type DescriptorTrackingSyncApiName = "openSync" | "closeSync";
type DescriptorTrackingCallbackApiName = "open" | "close";

type MutableFsModule = Record<
  WritableFsApiName | DescriptorTrackingSyncApiName | DescriptorTrackingCallbackApiName,
  (...args: unknown[]) => unknown
> & {
  promises: MutablePromiseFsModule;
};
type MutablePromiseFsModule = Record<PromiseApiName, (...args: unknown[]) => unknown>;

export class VfsInterceptor {
  private readonly fsModule = require("node:fs") as MutableFsModule;
  private readonly fsPromisesModule = require("node:fs/promises") as MutablePromiseFsModule;
  private readonly restoreOriginals: Array<() => void> = [];
  private readonly descriptorPaths = new Map<number, { pathLike: unknown; suppressed: boolean }>();
  private readonly streamPathSuppressions = new Map<string, number>();
  private suppressDescriptorTrackingDepth = 0;
  private installed = false;

  public constructor(private readonly hooks: VfsInterceptorHooks) {}

  public install(): void {
    if (this.installed) {
      return;
    }

    this.patchDescriptorOpenSync("openSync");
    this.patchDescriptorCloseSync("closeSync");
    this.patchDescriptorOpenCallback("open");
    this.patchDescriptorCloseCallback("close");

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
    this.patchCallback("write", (args) => this.createDescriptorRecords(args[0], "write", "file"));
    this.patchCallback("writev", (args) => this.createDescriptorRecords(args[0], "write", "file"));
    this.patchCallback("truncate", (args) =>
      this.createPathOrDescriptorRecords(args[0], "write", "file"),
    );
    this.patchCallback("symlink", (args) => [{ pathLike: args[1], kind: "write", fileTypeHint: "symlink" }]);
    this.patchCallback("link", (args) => [{ pathLike: args[1], kind: "write", fileTypeHint: "file" }]);
    this.patchCallback("fchmod", (args) => this.createDescriptorRecords(args[0], "metadata"));
    this.patchCallback("futimes", (args) => this.createDescriptorRecords(args[0], "metadata"));
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

    this.patchPromiseModules("writeFile", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchPromiseModules("appendFile", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchPromiseModules("truncate", (args) =>
      this.createPathOrDescriptorRecords(args[0], "write", "file"),
    );
    this.patchPromiseModules("symlink", (args) => [
      { pathLike: args[1], kind: "write", fileTypeHint: "symlink" },
    ]);
    this.patchPromiseModules("link", (args) => [
      { pathLike: args[1], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchPromiseModules("rename", (args) => [
      { pathLike: args[0], kind: "delete" },
      { pathLike: args[1], kind: "write" },
    ]);
    this.patchPromiseModules("unlink", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patchPromiseModules("rm", (args) => [{ pathLike: args[0], kind: "delete" }]);
    this.patchPromiseModules("mkdir", (args) => [
      { pathLike: args[0], kind: "mkdir", fileTypeHint: "directory" },
    ]);
    this.patchPromiseModules("copyFile", (args) => [
      { pathLike: args[1], kind: "write", fileTypeHint: "file" },
    ]);
    this.patchPromiseModules("chmod", (args) => [{ pathLike: args[0], kind: "metadata" }]);
    this.patchPromiseModules("utimes", (args) => [{ pathLike: args[0], kind: "metadata" }]);

    this.patchStream("createWriteStream", (args) => [
      { pathLike: args[0], kind: "write", fileTypeHint: "file" },
    ]);

    this.installed = true;
  }

  public uninstall(): void {
    if (!this.installed) {
      return;
    }

    for (const restoreOriginal of this.restoreOriginals) {
      restoreOriginal();
    }

    this.restoreOriginals.length = 0;
    this.descriptorPaths.clear();
    this.streamPathSuppressions.clear();
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
    this.restoreOriginals.push(() => {
      this.fsModule[apiName] = original;
    });

    this.fsModule[apiName] = (...args: unknown[]) => {
      this.hooks.beforeMutation(getRecords(args));
      try {
        return this.withDescriptorTrackingSuppressed(() => original.apply(this.fsModule, args));
      } catch (error) {
        this.hooks.mutationFailed?.(getRecords(args));
        throw error;
      }
    };
  }

  private patchCallback(
    apiName: CallbackApiName,
    getRecords: (args: unknown[]) => VfsMutationRecord[],
  ): void {
    const original = this.fsModule[apiName];
    this.restoreOriginals.push(() => {
      this.fsModule[apiName] = original;
    });

    this.fsModule[apiName] = (...args: unknown[]) => {
      if (typeof args.at(-1) === "function") {
        const records = getRecords(args);
        this.hooks.beforeMutation(records);
        const maybeCb = args.at(-1);
        const hooks = this.hooks;
        const patchedArgs = [...args];
        patchedArgs[patchedArgs.length - 1] = function (this: unknown, ...cbArgs: unknown[]) {
          if (cbArgs[0]) {
            hooks.mutationFailed?.(records);
          }
          return (maybeCb as (...a: unknown[]) => unknown).apply(this, cbArgs);
        };
        return this.withDescriptorTrackingSuppressed(() => original.apply(this.fsModule, patchedArgs));
      }

      return original.apply(this.fsModule, args);
    };
  }

  private patchPromiseModules(
    apiName: PromiseApiName,
    getRecords: (args: unknown[]) => VfsMutationRecord[],
  ): void {
    const patchedTargets = new Set<MutablePromiseFsModule>();

    for (const target of [this.fsModule.promises, this.fsPromisesModule]) {
      if (patchedTargets.has(target)) {
        continue;
      }

      patchedTargets.add(target);
      this.patchPromise(target, apiName, getRecords);
    }
  }

  private patchPromise(
    target: MutablePromiseFsModule,
    apiName: PromiseApiName,
    getRecords: (args: unknown[]) => VfsMutationRecord[],
  ): void {
    const original = target[apiName];
    this.restoreOriginals.push(() => {
      target[apiName] = original;
    });

    target[apiName] = (...args: unknown[]) => {
      const records = getRecords(args);
      this.hooks.beforeMutation(records);
      try {
        const promise = this.withDescriptorTrackingSuppressed(
          () => original.apply(target, args) as Promise<unknown>,
        );
        return promise.then(
          (result) => result,
          (error) => {
            this.hooks.mutationFailed?.(records);
            throw error;
          },
        );
      } catch (error) {
        this.hooks.mutationFailed?.(records);
        throw error;
      }
    };
  }

  private patchStream(
    apiName: StreamApiName,
    getRecords: (args: unknown[]) => VfsMutationRecord[],
  ): void {
    const original = this.fsModule[apiName];
    this.restoreOriginals.push(() => {
      this.fsModule[apiName] = original;
    });

    this.fsModule[apiName] = (...args: unknown[]) => {
      this.hooks.beforeMutation(getRecords(args));
      try {
        const stream = this.withDescriptorTrackingSuppressed(
          () => original.apply(this.fsModule, args) as NodeJS.WritableStream,
        );
        const releaseSuppression = this.markStreamPathSuppressed(args[0]);
        const streamObject =
          stream !== null && (typeof stream === "object" || typeof stream === "function")
            ? (stream as object)
            : undefined;

        if (streamObject && streamSuppressionOwners.has(streamObject)) {
          releaseSuppression();
          return stream;
        }

        if (streamObject) {
          streamSuppressionOwners.add(streamObject);
        }

        if (typeof (stream as { once?: unknown }).once === "function") {
          let released = false;
          const release = () => {
            if (released) {
              return;
            }

            released = true;
            if (streamObject) {
              streamSuppressionOwners.delete(streamObject);
            }
            releaseSuppression();
          };
          const streamWithOnce = stream as {
            once(event: "close" | "error" | "finish", listener: () => void): void;
          };

          streamWithOnce.once("close", release);
          streamWithOnce.once("error", release);
          streamWithOnce.once("finish", release);
        } else {
          if (streamObject) {
            streamSuppressionOwners.delete(streamObject);
          }

          releaseSuppression();
        }

        return stream;
      } catch (error) {
        this.hooks.mutationFailed?.(getRecords(args));
        throw error;
      }
    };
  }

  private patchDescriptorOpenSync(apiName: "openSync"): void {
    const original = this.fsModule[apiName];
    this.restoreOriginals.push(() => {
      this.fsModule[apiName] = original;
    });

    this.fsModule[apiName] = (...args: unknown[]) => {
      const descriptor = original.apply(this.fsModule, args);

      if (this.isFileDescriptor(descriptor)) {
        this.descriptorPaths.set(descriptor, {
          pathLike: args[0],
          suppressed:
            this.suppressDescriptorTrackingDepth > 0 || this.isSuppressedStreamPath(args[0]),
        });
      }

      return descriptor;
    };
  }

  private patchDescriptorCloseSync(apiName: "closeSync"): void {
    const original = this.fsModule[apiName];
    this.restoreOriginals.push(() => {
      this.fsModule[apiName] = original;
    });

    this.fsModule[apiName] = (...args: unknown[]) => {
      const descriptor = args[0];
      const result = original.apply(this.fsModule, args);

      if (this.isFileDescriptor(descriptor)) {
        this.descriptorPaths.delete(descriptor);
      }

      return result;
    };
  }

  private patchDescriptorOpenCallback(apiName: "open"): void {
    const original = this.fsModule[apiName];
    this.restoreOriginals.push(() => {
      this.fsModule[apiName] = original;
    });

    this.fsModule[apiName] = (...args: unknown[]) => {
      if (typeof args.at(-1) !== "function") {
        return original.apply(this.fsModule, args);
      }

      const interceptor = this;
      const maybeCallback = args.at(-1) as (...callbackArgs: unknown[]) => unknown;
      const patchedArgs = [...args];
      const pathLike = args[0];
      const suppressed =
        this.suppressDescriptorTrackingDepth > 0 || this.isSuppressedStreamPath(pathLike);

      patchedArgs[patchedArgs.length - 1] = function (this: unknown, ...callbackArgs: unknown[]) {
        const descriptor = callbackArgs[1];

        if (!callbackArgs[0] && interceptor.isFileDescriptor(descriptor)) {
          interceptor.descriptorPaths.set(descriptor, {
            pathLike,
            suppressed,
          });
        }

        return maybeCallback.apply(this, callbackArgs);
      };

      return original.apply(this.fsModule, patchedArgs);
    };
  }

  private patchDescriptorCloseCallback(apiName: "close"): void {
    const original = this.fsModule[apiName];
    this.restoreOriginals.push(() => {
      this.fsModule[apiName] = original;
    });

    this.fsModule[apiName] = (...args: unknown[]) => {
      if (typeof args.at(-1) !== "function") {
        return original.apply(this.fsModule, args);
      }

      const interceptor = this;
      const maybeCallback = args.at(-1) as (...callbackArgs: unknown[]) => unknown;
      const patchedArgs = [...args];
      const descriptor = args[0];

      patchedArgs[patchedArgs.length - 1] = function (this: unknown, ...callbackArgs: unknown[]) {
        if (!callbackArgs[0] && interceptor.isFileDescriptor(descriptor)) {
          interceptor.descriptorPaths.delete(descriptor);
        }

        return maybeCallback.apply(this, callbackArgs);
      };

      return original.apply(this.fsModule, patchedArgs);
    };
  }

  private createDescriptorRecords(
    descriptor: unknown,
    kind: VfsMutationKind,
    fileTypeHint?: DirtyEntry["fileType"],
  ): VfsMutationRecord[] {
    return [
      this.createRecord(this.resolveDescriptorPathLike(descriptor), kind, fileTypeHint),
    ];
  }

  private createPathOrDescriptorRecords(
    pathOrDescriptor: unknown,
    kind: VfsMutationKind,
    fileTypeHint?: DirtyEntry["fileType"],
  ): VfsMutationRecord[] {
    return [this.createRecord(this.resolvePathOrDescriptor(pathOrDescriptor), kind, fileTypeHint)];
  }

  private createRecord(
    pathLike: unknown,
    kind: VfsMutationKind,
    fileTypeHint?: DirtyEntry["fileType"],
  ): VfsMutationRecord {
    if (fileTypeHint) {
      return { pathLike, kind, fileTypeHint };
    }

    return { pathLike, kind };
  }

  private resolvePathOrDescriptor(pathOrDescriptor: unknown): unknown {
    if (this.isFileDescriptor(pathOrDescriptor)) {
      return this.resolveDescriptorPathLike(pathOrDescriptor);
    }

    return pathOrDescriptor;
  }

  private resolveDescriptorPathLike(descriptor: unknown): unknown {
    if (!this.isFileDescriptor(descriptor)) {
      return undefined;
    }

    const descriptorPath = this.descriptorPaths.get(descriptor);
    if (!descriptorPath || descriptorPath.suppressed) {
      return undefined;
    }

    return descriptorPath.pathLike;
  }

  private isFileDescriptor(value: unknown): value is number {
    return typeof value === "number" && Number.isInteger(value) && value >= 0;
  }

  private withDescriptorTrackingSuppressed<T>(operation: () => T): T {
    this.suppressDescriptorTrackingDepth += 1;

    try {
      return operation();
    } finally {
      this.suppressDescriptorTrackingDepth -= 1;
    }
  }

  private markStreamPathSuppressed(pathLike: unknown): () => void {
    const key = this.pathLikeKey(pathLike);

    if (!key) {
      return () => undefined;
    }

    this.streamPathSuppressions.set(key, (this.streamPathSuppressions.get(key) ?? 0) + 1);
    let released = false;

    return () => {
      if (released) {
        return;
      }

      released = true;
      const count = this.streamPathSuppressions.get(key);

      if (!count || count <= 1) {
        this.streamPathSuppressions.delete(key);
        return;
      }

      this.streamPathSuppressions.set(key, count - 1);
    };
  }

  private isSuppressedStreamPath(pathLike: unknown): boolean {
    const key = this.pathLikeKey(pathLike);

    if (!key) {
      return false;
    }

    return (this.streamPathSuppressions.get(key) ?? 0) > 0;
  }

  private pathLikeKey(pathLike: unknown): string | undefined {
    if (typeof pathLike === "string") {
      return `str:${pathLike}`;
    }

    if (Buffer.isBuffer(pathLike)) {
      return `buf:${pathLike.toString()}`;
    }

    if (pathLike instanceof URL) {
      return `url:${pathLike.href}`;
    }

    return undefined;
  }
}
