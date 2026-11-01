/** A verified journal's original note backup cannot safely support recovery. */
export class InkImportNoteBackupError extends Error {
  public constructor(
    public readonly notePath: string,
    public readonly backupPath: string,
    public readonly reason: "unavailable" | "changed",
  ) {
    super("The original note backup could not be verified; recovery stopped.");
    this.name = "InkImportNoteBackupError";
  }
}
