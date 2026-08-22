export type SaveErrorCode =
  "external-conflict" | "stale-editor-revision" | "read-back-mismatch" | "vault-write-failed";

export class SaveError extends Error {
  public constructor(public readonly code: SaveErrorCode) {
    super(code);
    this.name = "SaveError";
  }
}
