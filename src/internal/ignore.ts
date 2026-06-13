import { toPosixPath } from "./path.js";

export interface IgnoreMatcher {
  matches(relativePath: string): boolean;
}

export function createIgnoreMatcher(patterns: readonly string[]): IgnoreMatcher {
  const rules = patterns.map((pattern) => compileIgnorePattern(pattern));

  return {
    matches(relativePath: string): boolean {
      const normalizedPath = normalizePattern(relativePath);
      return rules.some((rule) => rule(normalizedPath));
    },
  };
}

type IgnoreRule = (relativePath: string) => boolean;

function compileIgnorePattern(pattern: string): IgnoreRule {
  const normalizedPattern = normalizePattern(pattern);

  if (normalizedPattern === "**" || normalizedPattern === "*") {
    return () => true;
  }

  if (normalizedPattern.endsWith("/**")) {
    const prefix = normalizedPattern.slice(0, -3);
    return (relativePath) => relativePath === prefix || relativePath.startsWith(`${prefix}/`);
  }

  if (!normalizedPattern.includes("*")) {
    return (relativePath) =>
      relativePath === normalizedPattern || relativePath.startsWith(`${normalizedPattern}/`);
  }

  const regex = new RegExp(`^${globToRegexSource(normalizedPattern)}$`);
  return (relativePath) => regex.test(relativePath);
}

function normalizePattern(pattern: string): string {
  return toPosixPath(pattern.trim()).replace(/^\/+/, "").replace(/\/+$/, "");
}

function globToRegexSource(pattern: string): string {
  let source = "";

  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    const next = pattern[index + 1];

    if (char === "*" && next === "*") {
      source += ".*";
      index += 1;
      continue;
    }

    if (char === "*") {
      source += "[^/]*";
      continue;
    }

    source += escapeRegexChar(char);
  }

  return source;
}

function escapeRegexChar(char: string | undefined): string {
  if (!char) {
    return "";
  }

  return "\\^$+?.()|[]{}".includes(char) ? `\\${char}` : char;
}
