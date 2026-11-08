import { MarkdownView, Platform, type App, type EventRef, type WorkspaceLeaf } from "obsidian";

export interface NativePdfOptions {
  readonly scale: number;
  readonly pageSize: string;
  readonly landscape: boolean;
  readonly margin: "0" | "1" | "2";
}

interface PrivatePdfVault {
  getConfig?(key: "pdfExportSettings"): unknown;
  on(name: "config-changed", callback: (key: string) => void): EventRef;
}

interface PendingPdfExport {
  readonly view: MarkdownView;
  readonly sourcePath: string;
  readonly createdAt: number;
  readonly options: NativePdfOptions;
  readonly release: () => void;
}

const PAGE_SIZES = new Set(["A3", "A4", "A5", "Legal", "Letter", "Tabloid"]);

/** The sole private PDF read: fresh native settings, never persisted preferences alone. */
export class NativePdfOptionsGateway {
  readonly #app: App;
  readonly #pending = new Map<Window, PendingPdfExport>();
  readonly #documents = new WeakMap<
    Document,
    { root: HTMLElement; sourcePath: string; options: NativePdfOptions }
  >();
  readonly #release: Array<() => void> = [];
  #disposed = false;

  constructor(app: App) {
    this.#app = app;
    if (!Platform.isDesktopApp) return;
    try {
      const vault = app.vault as unknown as PrivatePdfVault;
      if (typeof vault.getConfig !== "function") return;
      const options = vault.on("config-changed", this.#onOptionsChanged);
      this.#release.push(() => app.vault.offref(options));
      const leaf = app.workspace.on("active-leaf-change", this.#onLeafChange);
      this.#release.push(() => app.workspace.offref(leaf));
      const file = app.workspace.on("file-open", () => this.#onLeafChange());
      this.#release.push(() => app.workspace.offref(file));
    } catch {
      this.dispose();
    }
  }

  bind(root: HTMLElement, sourcePath: string): NativePdfOptions | undefined {
    if (this.#disposed) return undefined;
    const bound = this.#documents.get(root.ownerDocument);
    if (bound !== undefined)
      return bound.root === root && bound.sourcePath === sourcePath ? bound.options : undefined;
    const target = root.ownerDocument.defaultView;
    if (target === null || !root.isConnected) return undefined;
    try {
      const source = target.opener as Window | null;
      if (
        source === null ||
        source === target ||
        source.closed ||
        target.closed ||
        target.location.href !== "about:blank"
      )
        return;
      const ticket = this.#pending.get(source);
      if (
        ticket === undefined ||
        ticket.sourcePath !== sourcePath ||
        ticket.view.file?.path !== sourcePath ||
        !ticket.view.containerEl.isConnected ||
        !Number.isFinite(target.performance.timeOrigin) ||
        target.performance.timeOrigin < ticket.createdAt
      )
        return undefined;
      this.#drop(source);
      this.#documents.set(root.ownerDocument, { root, sourcePath, options: ticket.options });
      return ticket.options;
    } catch {
      return undefined;
    }
  }

  dispose(): void {
    this.#disposed = true;
    for (const source of this.#pending.keys()) this.#drop(source);
    for (const release of this.#release.splice(0)) release();
  }

  readonly #onOptionsChanged = (key: string): void => {
    if (this.#disposed || key !== "pdfExportSettings") return;
    const view = this.#app.workspace.getActiveViewOfType(MarkdownView);
    const source = view?.containerEl.ownerDocument.defaultView;
    if (view?.file === null || view === null || source === undefined || source === null) return;
    this.#drop(source);
    const options = this.#readOptions();
    if (options === undefined) return;
    const invalidate = () => this.#drop(source);
    source.addEventListener("pointerdown", invalidate, true);
    source.addEventListener("keydown", invalidate, true);
    source.addEventListener("unload", invalidate, { once: true });
    this.#pending.set(source, {
      view,
      sourcePath: view.file.path,
      createdAt: source.performance.timeOrigin + source.performance.now(),
      options,
      release: () => {
        source.removeEventListener("pointerdown", invalidate, true);
        source.removeEventListener("keydown", invalidate, true);
        source.removeEventListener("unload", invalidate);
      },
    });
  };

  readonly #onLeafChange = (leaf?: WorkspaceLeaf | null): void => {
    const active = leaf?.view ?? this.#app.workspace.getActiveViewOfType(MarkdownView);
    for (const [source, ticket] of this.#pending) {
      if (
        ticket.view.file?.path !== ticket.sourcePath ||
        !ticket.view.containerEl.isConnected ||
        (active?.containerEl.ownerDocument.defaultView === source && active !== ticket.view)
      )
        this.#drop(source);
    }
  };

  #drop(source: Window): void {
    const ticket = this.#pending.get(source);
    if (ticket === undefined) return;
    this.#pending.delete(source);
    ticket.release();
  }

  #readOptions(): NativePdfOptions | undefined {
    try {
      const vault = this.#app.vault as unknown as PrivatePdfVault;
      return validateNativePdfOptions(vault.getConfig?.("pdfExportSettings"));
    } catch {
      return undefined;
    }
  }
}

function validateNativePdfOptions(value: unknown): NativePdfOptions | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { pageSize, landscape, margin, downscalePercent } = value as Record<string, unknown>;
  if (
    typeof pageSize !== "string" ||
    !PAGE_SIZES.has(pageSize) ||
    typeof landscape !== "boolean" ||
    (margin !== "0" && margin !== "1" && margin !== "2") ||
    typeof downscalePercent !== "number" ||
    !Number.isInteger(downscalePercent) ||
    downscalePercent < 10 ||
    downscalePercent > 100
  )
    return undefined;
  return Object.freeze({ scale: downscalePercent / 100, pageSize, landscape, margin });
}
