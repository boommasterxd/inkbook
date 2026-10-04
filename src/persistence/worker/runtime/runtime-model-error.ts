export class RuntimeModelError extends Error {
  public constructor(
    public readonly code: string,
    public readonly retryable: boolean,
  ) {
    super(code);
    this.name = "RuntimeModelError";
  }
}
