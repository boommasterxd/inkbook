import {
  decodeEmbeddedSource,
  isEmbeddedSourceWindow,
  type EmbeddedSourceWindow,
} from "../../persistence/worker/runtime/embedded-source";
import type { InkbookEditorChromeProps } from "../../rendering/ui/editor-chrome";
import { EDITOR_CHROME_GZIP } from "../../rendering/ui/editor-chrome-source";
import type { MountedEditorChrome } from "../../rendering/ui/mount-editor-chrome";

interface EditorChromeModule {
  readonly mountEditorChrome: (
    container: HTMLElement,
    initialProps: InkbookEditorChromeProps,
  ) => MountedEditorChrome;
}

export interface EditorChromeWindow extends EmbeddedSourceWindow {
  readonly clearTimeout: (handle: number) => void;
  readonly setTimeout: (callback: () => void, milliseconds: number) => number;
  readonly URL: {
    createObjectURL(object: Blob): string;
    revokeObjectURL(url: string): void;
  };
}

export interface PendingEditorChrome {
  readonly ready: Promise<boolean>;
  readonly unmount: () => void;
  readonly update: (props: InkbookEditorChromeProps) => void;
}

type ModuleImporter = (url: string, owningWindow: EditorChromeWindow) => Promise<unknown>;

interface ModuleLoadRecord {
  cancel(): void;
  consumers: number;
  pending(): boolean;
  readonly promise: Promise<EditorChromeModule>;
}

interface ModuleLease {
  readonly module: Promise<EditorChromeModule>;
  release(): void;
}

const MODULE_LOAD_TIMEOUT_MS = 5_000;

export class EditorChromeModuleLoader {
  readonly #importModule: ModuleImporter;
  readonly #modules = new WeakMap<EditorChromeWindow, ModuleLoadRecord>();

  public constructor(importModule: ModuleImporter = nativeImport) {
    this.#importModule = importModule;
  }

  public acquire(owningWindow: unknown): ModuleLease {
    let browserWindow: EditorChromeWindow;
    try {
      browserWindow = requireEditorChromeWindow(owningWindow);
    } catch (error) {
      return rejectedLease(error);
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

  #startLoad(owningWindow: EditorChromeWindow): ModuleLoadRecord {
    let objectUrl: string | undefined;
    let settled = false;
    let resolveLoad = (_module: EditorChromeModule): void => undefined;
    let rejectLoad = (_error: unknown): void => undefined;
    const promise = new Promise<EditorChromeModule>((resolve, reject) => {
      resolveLoad = resolve;
      rejectLoad = reject;
    });
    let timer = owningWindow.setTimeout(() => {
      finish(undefined, new Error("The editor chrome module load timed out."));
    }, MODULE_LOAD_TIMEOUT_MS);
    const record: ModuleLoadRecord = {
      cancel: () => finish(undefined, new Error("The editor chrome module load was cancelled.")),
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

    function finish(module?: EditorChromeModule, error?: unknown): void {
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
    owningWindow: EditorChromeWindow,
    pending: () => boolean,
    ownObjectUrl: (url: string) => void,
  ): Promise<EditorChromeModule> {
    const source = await decodeEmbeddedSource(EDITOR_CHROME_GZIP, owningWindow);
    if (!pending()) throw new Error("The editor chrome module load is no longer active.");
    const blob = new owningWindow.Blob([source], { type: "text/javascript" });
    const createdUrl = owningWindow.URL.createObjectURL(blob);
    ownObjectUrl(createdUrl);
    const objectUrl = sanitizeOwnedModuleUrl(createdUrl);
    return requireEditorChromeModule(await this.#importModule(objectUrl, owningWindow));
  }
}

const productionLoader = new EditorChromeModuleLoader();

export function beginEditorChromeMount(
  container: HTMLElement,
  initialProps: InkbookEditorChromeProps,
  loader: EditorChromeModuleLoader = productionLoader,
): PendingEditorChrome {
  const initialError = validateInitialMount(container, initialProps.ownerDocument);
  const lease =
    initialError === undefined
      ? loader.acquire(initialProps.ownerDocument.defaultView)
      : rejectedLease(initialError);
  let active = true;
  let latestProps = initialProps;
  let mounted: MountedEditorChrome | undefined;
  const ready = lease.module.then(
    async (module) => {
      lease.release();
      if (!active) return false;
      mounted = module.mountEditorChrome(container, latestProps);
      const committed = await mounted.ready;
      return active && committed;
    },
    (error: unknown) => {
      lease.release();
      if (!active) return false;
      throw error;
    },
  );

  return {
    ready,
    unmount: () => {
      if (!active) return;
      active = false;
      lease.release();
      mounted?.unmount();
    },
    update: (props) => {
      if (!active) throw new Error("Cannot update an unmounted Inkbook editor chrome");
      assertOwnerDocument(container, props.ownerDocument);
      latestProps = props;
      mounted?.update(props);
    },
  };
}

function rejectedLease(error: unknown): ModuleLease {
  const reason =
    error instanceof Error ? error : new Error("The editor chrome module load failed.");
  return { module: Promise.reject(reason), release: () => undefined };
}

async function nativeImport(url: string): Promise<unknown> {
  return import(sanitizeOwnedModuleUrl(url));
}

function sanitizeOwnedModuleUrl(url: string): string {
  if (!url.startsWith("blob:")) {
    throw new Error("The editor chrome module URL is not an owned Blob URL.");
  }
  return url;
}

function requireEditorChromeModule(value: unknown): EditorChromeModule {
  if (
    typeof value !== "object" ||
    value === null ||
    !("mountEditorChrome" in value) ||
    typeof value.mountEditorChrome !== "function"
  ) {
    throw new Error("The embedded editor chrome module is invalid.");
  }
  return value as EditorChromeModule;
}

function requireEditorChromeWindow(value: unknown): EditorChromeWindow {
  if (!isEditorChromeWindow(value)) {
    throw new Error("The owning window does not provide embedded module APIs.");
  }
  return value;
}

function isEditorChromeWindow(value: unknown): value is EditorChromeWindow {
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
  return (
    typeof url === "object" &&
    url !== null &&
    "createObjectURL" in url &&
    typeof url.createObjectURL === "function" &&
    "revokeObjectURL" in url &&
    typeof url.revokeObjectURL === "function"
  );
}

function assertOwnerDocument(container: HTMLElement, ownerDocument: Document): void {
  if (container.ownerDocument !== ownerDocument) {
    throw new Error("Inkbook editor chrome must mount in its owning document");
  }
}

function validateInitialMount(container: HTMLElement, ownerDocument: Document): Error | undefined {
  if (container.ownerDocument !== ownerDocument) {
    return new Error("Inkbook editor chrome must mount in its owning document");
  }
  if (ownerDocument.defaultView === null) {
    return new Error("The editor chrome requires an owning window.");
  }
  return undefined;
}
