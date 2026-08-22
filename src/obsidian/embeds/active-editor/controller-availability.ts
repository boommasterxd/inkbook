export interface ActiveEditorAvailabilityOptions {
  readonly onDisabled: () => void;
  readonly onStateChanged: () => void;
  readonly setInputInert: (inert: boolean) => void;
}

/** Owns the two reasons an attached editor can reject interactive input. */
export class ActiveEditorAvailability {
  readonly #options: ActiveEditorAvailabilityOptions;
  #enabled = true;
  #pending = false;

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
    if (!enabled) this.#options.onDisabled();
    this.#sync();
  }

  public setPending(pending: boolean): void {
    if (pending === this.#pending) return;
    this.#pending = pending;
    this.#sync();
  }

  #sync(): void {
    this.#options.setInputInert(!this.acceptsInput);
    this.#options.onStateChanged();
  }
}
