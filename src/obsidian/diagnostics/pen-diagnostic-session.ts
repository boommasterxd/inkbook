import { TFolder, type TFile, type Vault } from "obsidian";

import { PEN_DIAGNOSTIC_MAX_EVENTS, PenEventCapture } from "./pen-event-capture";

export interface PenDiagnosticOptions {
  readonly vault: Pick<Vault, "getAbstractFileByPath" | "createFolder" | "create" | "append">;
  readonly ownerWindow: Window;
  readonly pluginVersion: string;
  readonly obsidianVersion: string;
  readonly notify: (message: string) => void;
}

const DIRECTORY = "Inkbook Diagnostics";
const SAVE_INTERVAL_MS = 5_000;
const SESSION_DURATION_MS = 120_000;

/** Explicit, bounded device diagnostics; writes only through the public Vault API. */
export class PenDiagnosticSession {
  readonly #options: PenDiagnosticOptions;
  readonly #capture: PenEventCapture;
  #file: TFile | undefined;
  #starting: Promise<void> | undefined;
  #recording = false;
  #disposed = false;
  #saveTimer: number | undefined;
  #endTimer: number | undefined;
  #pendingText = "";
  #write: Promise<boolean> | undefined;
  #finish: Promise<void> | undefined;

  public constructor(options: PenDiagnosticOptions) {
    this.#options = options;
    this.#capture = new PenEventCapture({ onLimit: () => void this.stop("event-limit") });
  }

  public get canStart(): boolean {
    return (
      !this.#disposed &&
      this.#starting === undefined &&
      this.#finish === undefined &&
      this.#file === undefined
    );
  }

  public get canStop(): boolean {
    return (this.#starting !== undefined || this.#file !== undefined) && this.#finish === undefined;
  }

  public addWindow(ownerWindow: Window): () => void {
    return this.#capture.addWindow(ownerWindow);
  }

  public start(): Promise<void> {
    if (!this.canStart) return Promise.resolve();
    this.#starting = this.#startRecording().finally(() => {
      this.#starting = undefined;
    });
    return this.#starting;
  }

  async #startRecording(): Promise<void> {
    try {
      await this.#ensureDirectory();
      const date = new Date().toISOString().replaceAll(":", "-");
      const path = `${DIRECTORY}/pen-input-${date}-${crypto.randomUUID()}.md`;
      this.#file = await this.#options.vault.create(path, this.#header());
      if (this.#disposed || this.#finish !== undefined) return;
      this.#capture.start();
      this.#recording = true;
      this.#scheduleSave();
      this.#endTimer = this.#options.ownerWindow.setTimeout(
        () => void this.stop("time-limit"),
        SESSION_DURATION_MS,
      );
      this.#options.notify(
        "Pen diagnostics started. Test hover, button press, contact, release and lift. The Markdown log saves automatically.",
      );
    } catch {
      this.#options.notify(
        "Could not start pen diagnostics. Check vault write access and try again.",
      );
    }
  }

  public stop(reason = "manual"): Promise<void> {
    if (this.#finish !== undefined) return this.#finish;
    this.#recording = false;
    this.#capture.stop();
    this.#clearTimers();
    this.#finish = this.#finishRecording(reason).finally(() => {
      this.#finish = undefined;
    });
    return this.#finish;
  }

  async #finishRecording(reason: string): Promise<void> {
    await this.#starting;
    await this.#saveFinal(reason);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    void this.stop("plugin-unload");
    this.#capture.dispose();
  }

  async #ensureDirectory(): Promise<void> {
    const existing = this.#options.vault.getAbstractFileByPath(DIRECTORY);
    if (existing === null) await this.#options.vault.createFolder(DIRECTORY);
    else if (!(existing instanceof TFolder)) throw new Error("Diagnostic folder is unavailable.");
  }

  #header(): string {
    const window = this.#options.ownerWindow;
    const environment = {
      schema: 1,
      startedAt: new Date().toISOString(),
      pluginVersion: this.#options.pluginVersion,
      obsidianVersion: this.#options.obsidianVersion,
      maxTouchPoints: window.navigator.maxTouchPoints,
      viewport: [window.innerWidth, window.innerHeight],
      devicePixelRatio: window.devicePixelRatio,
      pointerEvents: "PointerEvent" in window,
      pointerRawUpdate: "onpointerrawupdate" in window,
      durationLimitMs: SESSION_DURATION_MS,
      eventLimit: PEN_DIAGNOSTIC_MAX_EVENTS,
      saveIntervalMs: SAVE_INTERVAL_MS,
    };
    return (
      "# Inkbook pen diagnostics\n\n" +
      "Local input-event log. No note text, file paths, clipboard contents or typed keys are recorded. Coordinates can reveal pen movements. Vault sync may synchronize this file.\n\n" +
      "Test on an empty drawing: hover; press/release the side button; hold it while touching down; release during contact; lift. Repeat by pressing during a normal stroke.\n\n" +
      "Add device model, stylus model and Android/One UI version here: \n\n" +
      `## Environment\n\n\`\`\`json\n${JSON.stringify(environment, null, 2)}\n\`\`\`\n\n` +
      "## Events\n\nEach batch is JSON Lines. Flags describe capture-time state before Inkbook handles the event. Missing native events cannot be observed here.\n"
    );
  }

  #scheduleSave(): void {
    if (!this.#recording) return;
    this.#saveTimer = this.#options.ownerWindow.setTimeout(() => {
      this.#saveTimer = undefined;
      void this.#flush().then((saved) => {
        if (saved) this.#scheduleSave();
        else this.#saveFailed();
      });
    }, SAVE_INTERVAL_MS);
  }

  #flush(): Promise<boolean> {
    if (this.#write !== undefined) return this.#write;
    const file = this.#file;
    if (file === undefined) return Promise.resolve(true);
    if (this.#pendingText === "") {
      const records = this.#capture.drain();
      if (records.length === 0) return Promise.resolve(true);
      this.#pendingText = `\n\`\`\`jsonl\n${records.map((record) => JSON.stringify(record)).join("\n")}\n\`\`\`\n`;
    }
    this.#write = this.#options.vault
      .append(file, this.#pendingText)
      .then(
        () => {
          this.#pendingText = "";
          return true;
        },
        () => false,
      )
      .finally(() => {
        this.#write = undefined;
      });
    return this.#write;
  }

  async #saveFinal(reason: string): Promise<void> {
    if (this.#file === undefined) return;
    if (!(await this.#flush()) || !(await this.#flush())) {
      this.#saveFailed();
      return;
    }
    try {
      await this.#options.vault.append(
        this.#file,
        `\n## Recording ended\n\nReason: ${reason}. Captured events: ${this.#capture.eventCount}.\n`,
      );
      const path = this.#file.path;
      this.#file = undefined;
      if (!this.#disposed) this.#options.notify(`Pen diagnostics saved: ${path}`);
    } catch {
      this.#saveFailed();
    }
  }

  #saveFailed(): void {
    this.#recording = false;
    this.#capture.stop();
    this.#clearTimers();
    if (!this.#disposed)
      this.#options.notify(
        "Pen diagnostic saving failed. Recording stopped; use Stop and save pen diagnostics to retry before closing Obsidian.",
      );
  }

  #clearTimers(): void {
    if (this.#saveTimer !== undefined) this.#options.ownerWindow.clearTimeout(this.#saveTimer);
    if (this.#endTimer !== undefined) this.#options.ownerWindow.clearTimeout(this.#endTimer);
    this.#saveTimer = undefined;
    this.#endTimer = undefined;
  }
}
