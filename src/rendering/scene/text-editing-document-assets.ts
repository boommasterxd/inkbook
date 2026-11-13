import type { SceneDocumentAssets } from "./scene-surface-document";

/** Reuses canonical font CSS and the existing theme relay for one native input document. */
export class TextEditingDocumentAssets implements SceneDocumentAssets {
  public readonly ready: Promise<void>;
  readonly #style: HTMLStyleElement;
  readonly #loaded = new Map<string, Promise<void>>();
  readonly #abort = new AbortController();
  #stylesheet = "";

  public constructor(
    private readonly options: {
      readonly document: Document;
      readonly source: Document;
      readonly stylesheet: () => string;
      readonly releaseTheme: () => void;
    },
  ) {
    this.#style = options.document.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "style",
    ) as HTMLStyleElement;
    this.#style.id = "inkbook-fonts";
    options.document.head.append(this.#style);
    this.ready = this.prepare();
    void this.ready.catch(() => undefined);
  }

  public async prepare(): Promise<void> {
    const signal = this.#abort.signal;
    signal.throwIfAborted();
    const stylesheet = this.options.stylesheet();
    if (stylesheet !== this.#stylesheet) {
      this.#style.textContent = stylesheet;
      this.#stylesheet = stylesheet;
      this.#loaded.clear();
    }
    const source = this.options.source.fonts;
    const target = this.options.document.fonts;
    if (!source || !target) {
      if (stylesheet) throw new Error("Native editing font loading is unavailable.");
      return;
    }
    const pending: Promise<void>[] = [];
    for (const face of source) {
      const family = face.family.replace(/^["']|["']$/gu, "");
      if (face.status !== "loaded" || !/^inkbook-face-[a-f0-9]{64}$/u.test(family)) continue;
      const signature = `${face.style} ${Number.parseFloat(face.weight)} 24px "${family}"`;
      let loaded = this.#loaded.get(signature);
      if (!loaded) {
        if (this.#loaded.size >= 64)
          throw new RangeError("Native editing exceeds the document font limit.");
        loaded = target
          .load(signature)
          .then((faces) => {
            if (faces.length === 0) throw new Error("A native editor font face is unavailable.");
          })
          .catch((error: unknown) => {
            this.#loaded.delete(signature);
            throw error;
          });
        this.#loaded.set(signature, loaded);
      }
      pending.push(loaded);
    }
    if (pending.length === 0) return;
    let cancel = () => undefined as void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      cancel = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Native editor fonts were released."),
        );
      signal.addEventListener("abort", cancel, { once: true });
    });
    try {
      await Promise.race([Promise.all(pending), cancelled]);
      signal.throwIfAborted();
    } finally {
      signal.removeEventListener("abort", cancel);
    }
  }

  public dispose(): void {
    if (this.#abort.signal.aborted) return;
    this.#abort.abort();
    this.#loaded.clear();
    this.#style.remove();
    this.options.releaseTheme();
  }
}
