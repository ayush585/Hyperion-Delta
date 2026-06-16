export type HyperionErrorCode =
  | "HYPERION_CAPACITY"
  | "HYPERION_INTEGRITY"
  | "HYPERION_IGNORED_PATH"
  | "HYPERION_PATH"
  | "HYPERION_ROLLBACK"
  | "HYPERION_NOT_IMPLEMENTED";

export class HyperionError extends Error {
  public readonly code: HyperionErrorCode;

  public constructor(message: string, code: HyperionErrorCode = "HYPERION_NOT_IMPLEMENTED") {
    super(message);
    this.name = "HyperionError";
    this.code = code;
  }
}

export class HyperionCapacityError extends HyperionError {
  public constructor(message: string) {
    super(message, "HYPERION_CAPACITY");
    this.name = "HyperionCapacityError";
  }
}

export class HyperionIntegrityError extends HyperionError {
  public constructor(message: string) {
    super(message, "HYPERION_INTEGRITY");
    this.name = "HyperionIntegrityError";
  }
}

export class HyperionPathError extends HyperionError {
  public constructor(
    message: string,
    code: "HYPERION_PATH" | "HYPERION_IGNORED_PATH" = "HYPERION_PATH",
  ) {
    super(message, code);
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
  public constructor(message: string) {
    super(message, "HYPERION_ROLLBACK");
    this.name = "HyperionRollbackError";
  }
}
