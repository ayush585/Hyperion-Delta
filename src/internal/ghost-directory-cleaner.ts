import { existsSync, readdirSync, rmdirSync } from "node:fs";
import path from "node:path";

import type { StateManifest } from "../types.js";
import type { IgnoreMatcher } from "./ignore.js";
import { toPosixPath } from "./path.js";

export interface GhostDirectoryCleanerOptions {
  workspaceRoot: string;
  baseline: StateManifest;
  ignoreMatcher: IgnoreMatcher;
}

export class GhostDirectoryCleaner {
  public constructor(private readonly options: GhostDirectoryCleanerOptions) {}

  public cleanupAfterCreatedPath(relativePath: string): void {
    let currentDirectory = path.dirname(this.toWorkspacePath(relativePath));

    while (this.isInsideWorkspace(currentDirectory) && currentDirectory !== this.options.workspaceRoot) {
      const workspaceRelativeDirectory = toPosixPath(
        path.relative(this.options.workspaceRoot, currentDirectory),
      );

      if (
        workspaceRelativeDirectory === "" ||
        this.options.ignoreMatcher.matches(workspaceRelativeDirectory) ||
        this.options.baseline.statEntries.has(workspaceRelativeDirectory) ||
        !this.isEmptyDirectory(currentDirectory)
      ) {
        return;
      }

      rmdirSync(currentDirectory);
      currentDirectory = path.dirname(currentDirectory);
    }
  }

  private isEmptyDirectory(directoryPath: string): boolean {
    try {
      return existsSync(directoryPath) && readdirSync(directoryPath).length === 0;
    } catch {
      return false;
    }
  }

  private isInsideWorkspace(candidatePath: string): boolean {
    const relativePath = path.relative(this.options.workspaceRoot, candidatePath);
    return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
  }

  private toWorkspacePath(relativePath: string): string {
    return path.join(this.options.workspaceRoot, ...relativePath.split("/"));
  }
}
