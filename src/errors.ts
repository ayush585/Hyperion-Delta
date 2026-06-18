export type HyperionErrorCode =
  | "HYPERION_CAPACITY"
  | "HYPERION_INTEGRITY"
  | "HYPERION_IGNORED_PATH"
  | "HYPERION_PATH"
  | "HYPERION_ROLLBACK"
  | "HYPERION_NOT_IMPLEMENTED";

export interface HyperionErrorContext {
  reason?: string;
  cause?: unknown;
}

export class HyperionError extends Error {
  public readonly code: HyperionErrorCode;
  public readonly reason?: string;

  public constructor(
    message: string,
    code: HyperionErrorCode = "HYPERION_NOT_IMPLEMENTED",
    context: HyperionErrorContext = {},
  ) {
    super(message, context.cause === undefined ? undefined : { cause: context.cause });
    this.name = "HyperionError";
    this.code = code;
    if (context.reason !== undefined) {
      this.reason = context.reason;
    }
  }
}

export class HyperionCapacityError extends HyperionError {
  public constructor(message: string, context: HyperionErrorContext = {}) {
    super(message, "HYPERION_CAPACITY", context);
    this.name = "HyperionCapacityError";
  }
}

export class HyperionIntegrityError extends HyperionError {
  public constructor(message: string, context: HyperionErrorContext = {}) {
    super(message, "HYPERION_INTEGRITY", context);
    this.name = "HyperionIntegrityError";
  }
}

export class HyperionPathError extends HyperionError {
  public constructor(
    message: string,
    code: "HYPERION_PATH" | "HYPERION_IGNORED_PATH" = "HYPERION_PATH",
    context: HyperionErrorContext = {},
  ) {
    super(message, code, context);
    this.name = "HyperionPathError";
  }
}

export class HyperionIgnoredPathError extends HyperionPathError {
  public readonly relativePath: string;

  public constructor(relativePath: string) {
    super(
      `Ignored path mutation blocked by strictIgnoredWrites: ${relativePath}`,
      "HYPERION_IGNORED_PATH",
    );
    this.name = "HyperionIgnoredPathError";
    this.relativePath = relativePath;
  }
}

export class HyperionRollbackError extends HyperionError {
  public constructor(message: string, context: HyperionErrorContext = {}) {
    super(message, "HYPERION_ROLLBACK", context);
    this.name = "HyperionRollbackError";
  }
}
