/** The first authoritative editor paint may fail or be cancelled before its owner awaits it. */
export class TextEditorReadiness {
  public readonly ready: Promise<void>;
  public readonly resolve: () => void;
  public readonly reject: (error: unknown) => void;

  public constructor() {
    let resolve!: () => void;
    let reject!: (error: unknown) => void;
    this.ready = new Promise<void>((complete, fail) => {
      resolve = complete;
      reject = fail;
    });
    this.resolve = resolve;
    this.reject = reject;
    void this.ready.catch(() => undefined);
  }
}
