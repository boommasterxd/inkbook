import {
  decodeEmbeddedSource,
  isEmbeddedSourceWindow,
  type EmbeddedSourceWindow,
} from "../../persistence/worker/runtime/embedded-source";

export interface EmbeddedModuleWindow extends EmbeddedSourceWindow {
  readonly clearTimeout: (handle: number) => void;
  readonly setTimeout: (callback: () => void, milliseconds: number) => number;
  readonly URL: {
    createObjectURL(object: Blob): string;
    revokeObjectURL(url: string): void;
  };
}

interface EmbeddedModuleOptions<Module> {
  readonly source: string;
  readonly label: string;
  readonly validate: (value: unknown) => Module;
}

export type EmbeddedModuleImporter = (
  url: string,
  owningWindow: EmbeddedModuleWindow,
) => Promise<unknown>;

interface ModuleLoadRecord<Module> {
  cancel(): void;
  consumers: number;
  pending(): boolean;
  readonly promise: Promise<Module>;
}

export interface EmbeddedModuleLease<Module> {
  readonly module: Promise<Module>;
  release(): void;
}

const MODULE_LOAD_TIMEOUT_MS = 5_000;

export class EmbeddedModuleLoader<Module> {
  readonly #importModule: EmbeddedModuleImporter;
  readonly #modules = new WeakMap<EmbeddedModuleWindow, ModuleLoadRecord<Module>>();

  readonly #options: EmbeddedModuleOptions<Module>;

  public constructor(options: EmbeddedModuleOptions<Module>, importModule: EmbeddedModuleImporter) {
    this.#options = options;
    this.#importModule = importModule;
  }

  public acquire(owningWindow: unknown): EmbeddedModuleLease<Module> {
    let browserWindow: EmbeddedModuleWindow;
    try {
      browserWindow = requireEmbeddedModuleWindow(owningWindow);
    } catch (error) {
      return rejectedModuleLease(error);
    }
    const record = this.#modules.get(browserWindow) ?? this.#startLoad(browserWindow);
    record.consumers += 1;
    let released = false;
    return {
      module: record.promise,
      release: () => {
        if (released) return;
        released = true;
        record.consumers -= 1;
        if (record.consumers !== 0 || !record.pending()) return;
        this.#modules.delete(browserWindow);
        record.cancel();
      },
    };
  }

  #startLoad(owningWindow: EmbeddedModuleWindow): ModuleLoadRecord<Module> {
    let objectUrl: string | undefined;
    let settled = false;
    let resolveLoad = (_module: Module): void => undefined;
    let rejectLoad = (_error: unknown): void => undefined;
    const promise = new Promise<Module>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    let timer = owningWindow.setTimeout(() => {
      finish(undefined, new Error(`The ${this.#options.label} module load timed out.`));
    }, MODULE_LOAD_TIMEOUT_MS);
    const record: ModuleLoadRecord<Module> = {
      cancel: () =>
        finish(undefined, new Error(`The ${this.#options.label} module load was cancelled.`)),
      consumers: 0,
      pending: () => !settled,
      promise,
    };
    this.#modules.set(owningWindow, record);
    void this.#loadOwnedModule(
      owningWindow,
      () => !settled,
      (url) => {
        objectUrl = url;
      },
    ).then(
      (module) => finish(module),
      (error: unknown) => finish(undefined, error),
    );
    void promise.catch(() => {
      if (this.#modules.get(owningWindow) === record) this.#modules.delete(owningWindow);
    });
    return record;

    function finish(module?: Module, error?: unknown): void {
      if (settled) return;
      settled = true;
      owningWindow.clearTimeout(timer);
      timer = 0;
      if (objectUrl !== undefined) owningWindow.URL.revokeObjectURL(objectUrl);
      if (module !== undefined) resolveLoad(module);
      else rejectLoad(error);
    }
  }

  async #loadOwnedModule(
    owningWindow: EmbeddedModuleWindow,
    pending: () => boolean,
    ownObjectUrl: (url: string) => void,
  ): Promise<Module> {
    const source = await decodeEmbeddedSource(this.#options.source, owningWindow);
    if (!pending()) throw new Error(`The ${this.#options.label} module load is no longer active.`);
    const blob = new owningWindow.Blob([source], { type: "text/javascript" });
    const createdUrl = owningWindow.URL.createObjectURL(blob);
    ownObjectUrl(createdUrl);
    const objectUrl = sanitizeOwnedModuleUrl(createdUrl);
    return this.#options.validate(await this.#importModule(objectUrl, owningWindow));
  }
}

export function rejectedModuleLease<Module>(error: unknown): EmbeddedModuleLease<Module> {
  const reason = error instanceof Error ? error : new Error("The embedded module load failed.");
  return { module: Promise.reject(reason), release: () => undefined };
}

export function sanitizeOwnedModuleUrl(url: string): string {
  if (!url.startsWith("blob:")) {
    throw new Error("The embedded module URL is not an owned Blob URL.");
  }
  return url;
}

function requireEmbeddedModuleWindow(value: unknown): EmbeddedModuleWindow {
  if (!isEmbeddedModuleWindow(value)) {
    throw new Error("The owning window does not provide embedded module APIs.");
  }
  return value;
}

function isEmbeddedModuleWindow(value: unknown): value is EmbeddedModuleWindow {
  if (
    !isEmbeddedSourceWindow(value) ||
    !("URL" in value) ||
    !("clearTimeout" in value) ||
    typeof value.clearTimeout !== "function" ||
    !("setTimeout" in value) ||
    typeof value.setTimeout !== "function"
  )
    return false;
  const url: unknown = value.URL;
  if (url === null || (typeof url !== "object" && typeof url !== "function")) return false;
  return (
    "createObjectURL" in url &&
    typeof url.createObjectURL === "function" &&
    "revokeObjectURL" in url &&
    typeof url.revokeObjectURL === "function"
  );
}
