export const REQUIRED_IGNORED_PATTERNS = [
  "node_modules/**",
  ".git/**",
  ".hyperion/**",
] as const;

export const RECOMMENDED_IGNORED_PATTERNS = [
  ".pnpm-store/**",
  ".yarn/cache/**",
  ".npm/**",
  "dist/**",
  "build/**",
  "coverage/**",
  ".next/**",
  ".turbo/**",
  ".cache/**",
] as const;

export const DEFAULT_IGNORED_PATTERNS = [
  ...REQUIRED_IGNORED_PATTERNS,
  ...RECOMMENDED_IGNORED_PATTERNS,
] as const;

export const DEFAULT_MAX_CONCURRENT_CHECKPOINTS = 64;
