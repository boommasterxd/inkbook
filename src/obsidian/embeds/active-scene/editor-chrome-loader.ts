import {
  EmbeddedModuleLoader,
  sanitizeOwnedModuleUrl,
  rejectedModuleLease,
  type EmbeddedModuleImporter,
} from "../../runtime/embedded-module-loader";
import type { InkbookEditorChromeProps } from "../../../rendering/ui/editor-chrome";
import { EDITOR_CHROME_GZIP } from "../../../rendering/ui/editor-chrome-source";
import type { MountedEditorChrome } from "../../../rendering/ui/mount-editor-chrome";

interface EditorChromeModule {
  readonly mountEditorChrome: (
    container: HTMLElement,
    initialProps: InkbookEditorChromeProps,
  ) => MountedEditorChrome;
}

export interface PendingEditorChrome {
  readonly ready: Promise<boolean>;
  readonly unmount: () => void;
  readonly update: (props: InkbookEditorChromeProps) => void;
}

export class EditorChromeModuleLoader extends EmbeddedModuleLoader<EditorChromeModule> {
  public constructor(importModule: EmbeddedModuleImporter = nativeImport) {
    super(
      { source: EDITOR_CHROME_GZIP, label: "editor chrome", validate: requireEditorChromeModule },
      importModule,
    );
  }
}

const productionLoader = new EditorChromeModuleLoader();

/** Prepares only the shared module; React roots and editor effects still require activation. */
export function prepareEditorChrome(
  owningWindow: unknown,
  loader: EditorChromeModuleLoader = productionLoader,
): { readonly ready: Promise<boolean>; readonly release: () => void } {
  const lease = loader.acquire(owningWindow);
  return {
    ready: lease.module.then(
      () => {
        lease.release();
        return true;
      },
      () => {
        lease.release();
        return false;
      },
    ),
    release: () => lease.release(),
  };
}

export function beginEditorChromeMount(
  container: HTMLElement,
  initialProps: InkbookEditorChromeProps,
  loader: EditorChromeModuleLoader = productionLoader,
): PendingEditorChrome {
  const initialError = validateInitialMount(container, initialProps.ownerDocument);
  const lease =
    initialError === undefined
      ? loader.acquire(initialProps.ownerDocument.defaultView)
      : rejectedModuleLease<EditorChromeModule>(initialError);
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

async function nativeImport(url: string): Promise<unknown> {
  return import(sanitizeOwnedModuleUrl(url));
}
