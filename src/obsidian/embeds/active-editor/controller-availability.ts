export interface ActiveEditorAvailabilityOptions {
  readonly inputSurface: HTMLDivElement;
  readonly onDisabled: () => void;
  readonly onStateChanged: () => void;
}

/** Owns the two reasons an attached editor can reject interactive input. */
export class ActiveEditorAvailability {
  readonly #options: ActiveEditorAvailabilityOptions;
  #enabled = true;
  #pending = false;
  #restoreInputFocus = false;

  public constructor(options: ActiveEditorAvailabilityOptions) {
    this.#options = options;
  }

  public get acceptsInput(): boolean {
    return this.#enabled && !this.#pending;
  }

  public get attached(): boolean {
    return this.#enabled;
  }

  public setEnabled(enabled: boolean): void {
    if (enabled === this.#enabled) return;
    this.#enabled = enabled;
    if (!enabled) {
      this.#restoreInputFocus = false;
      this.#options.onDisabled();
    }
    this.#sync();
  }

  public setPending(pending: boolean): void {
    if (pending === this.#pending) return;
    this.#pending = pending;
    this.#sync();
  }

  #sync(): void {
    this.#setInputInert(!this.acceptsInput);
    this.#options.onStateChanged();
  }

  #setInputInert(inert: boolean): void {
    const surface = this.#options.inputSurface;
    const ownerDocument = surface.ownerDocument;
    if (inert) {
      if (!surface.inert) this.#restoreInputFocus = ownerDocument.activeElement === surface;
      surface.inert = true;
      return;
    }
    surface.inert = false;
    const restoreFocus = this.#restoreInputFocus;
    this.#restoreInputFocus = false;
    const activeElement = ownerDocument.activeElement;
    if (
      restoreFocus &&
      (activeElement === null ||
        activeElement === ownerDocument.body ||
        activeElement === ownerDocument.documentElement)
    ) {
      surface.focus({ preventScroll: true });
    }
  }
}
