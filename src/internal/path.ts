import path from "node:path";

import { HyperionPathError } from "../errors.js";

export type NormalizedWorkspacePath = string;

export function normalizeWorkspacePath(
  workspaceRoot: string,
  pathOrPathLike: string,
): NormalizedWorkspacePath {
  if (typeof pathOrPathLike !== "string" || pathOrPathLike.trim() === "") {
    throw new HyperionPathError("Workspace paths must be non-empty strings");
  }

  const rawPath = pathOrPathLike.trim();
  rejectTraversal(rawPath);

  const resolvedPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(workspaceRoot, rawPath);
  const relativePath = path.relative(workspaceRoot, resolvedPath);

  if (
    relativePath === "" ||
    relativePath.startsWith("..") ||
    path.isAbsolute(relativePath)
  ) {
    throw new HyperionPathError(`Path escapes workspace root: ${pathOrPathLike}`);
  }

  return toPosixPath(relativePath);
}

export function isPathInsideRoot(root: string, candidate: string): boolean {
  const relativePath = path.relative(root, candidate);
  return relativePath === "" || (!relativePath.startsWith("..") && !path.isAbsolute(relativePath));
}

export function toPosixPath(nativePath: string): string {
  return nativePath.replace(/\\/g, "/");
}

function rejectTraversal(rawPath: string): void {
  if (rawPath.includes("\0")) {
    throw new HyperionPathError(`Null bytes are not allowed in paths: ${rawPath}`);
  }

  if (/^[A-Za-z]:($|[^\\/])/.test(rawPath)) {
    throw new HyperionPathError(`Drive-relative paths are not allowed: ${rawPath}`);
  }

  const pathSegments = rawPath.replace(/\\/g, "/").split("/");

  if (pathSegments.some((segment) => segment === "..")) {
    throw new HyperionPathError(`Path traversal is not allowed: ${rawPath}`);
  }
}
