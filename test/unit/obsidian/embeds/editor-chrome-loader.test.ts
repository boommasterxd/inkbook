import { describe, expect, it, vi } from "vitest";

vi.mock("../../../../src/rendering/ui/editor-chrome-source", () => ({
  EDITOR_CHROME_GZIP:
    "<Ah!!!!!9-SOx5;6=n}85SXsqn,*>3h^H>}Exb9V{|jvA7Y:d=.UqU,ZbU-W<0z#{mr4#O5Q(g)*!!!!",
}));

import type { InkbookEditorChromeProps } from "../../../../src/rendering/ui/editor-chrome";
import {
  beginEditorChromeMount,
  EditorChromeModuleLoader,
  type EditorChromeWindow,
} from "../../../../src/obsidian/embeds/editor-chrome-loader";

interface WindowFixture {
  readonly blobs: Blob[];
  readonly document: Document;
  readonly revoked: string[];
  readonly runTimers: () => void;
  readonly window: EditorChromeWindow;
}

function createWindowFixture(name: string): WindowFixture {
  const blobs: Blob[] = [];
  const revoked: string[] = [];
  const timers = new Map<number, () => void>();
  let nextTimer = 0;
  const objectUrlApi = Object.assign(function URL() {}, {
    createObjectURL: (blob: Blob) => {
      blobs.push(blob);
      return `blob:${name}`;
    },
    revokeObjectURL: (url: string) => revoked.push(url),
  });
  const window: EditorChromeWindow = {
    Blob,
    clearTimeout: (handle) => timers.delete(handle),
    DecompressionStream,
    Response,
    setTimeout: (callback) => {
      const handle = ++nextTimer;
      timers.set(handle, callback);
      return handle;
    },
    URL: objectUrlApi,
  };
  const document = { defaultView: window } as unknown as Document;
  return {
    blobs,
    document,
    revoked,
    runTimers: () => {
      for (const callback of [...timers.values()]) callback();
    },
    window,
  };
}

function createProps(ownerDocument: Document, layout: "scrollable" | "wide" = "wide") {
  return {
    background: { spacing: null, type: "none" },
    callbacks: {
      onBackgroundSpacingChange: vi.fn(),
      onBackgroundTypeChange: vi.fn(),
      onFlyoutClose: vi.fn(),
      onOverflowAction: vi.fn(),
      onShapeChange: vi.fn(),
      onStyleChange: vi.fn(),
    },
    canvasInput: null,
    layout,
    onToolbarAction: vi.fn(),
    ownerDocument,
    overflowMenu: {
      arrange: {
        "bring-forward": false,
        "bring-to-front": false,
        "send-backward": false,
        "send-to-back": false,
      },
      canEraseAll: false,
      hasSelection: false,
    },
    renderIcon: vi.fn(),
    selectedShape: "line",
    styleControls: [],
    toolbarState: {
      activeTool: "draw",
      canPaste: false,
      canRedo: false,
      canUndo: false,
      fingerDrawingAvailable: false,
      fingerDrawingEnabled: false,
      hasSelection: false,
      openFlyout: null,
    },
  } satisfies InkbookEditorChromeProps;
}

function createContainer(ownerDocument: Document): HTMLElement {
  return { ownerDocument } as HTMLElement;
}

function deferred<T>() {
  let resolve = (_value: T): void => undefined;
  let reject = (_reason: unknown): void => undefined;
  const promise = new Promise<T>((accept, decline) => {
    resolve = accept;
    reject = decline;
  });
  return { promise, reject, resolve };
}

function startDeferredMount(fixture: WindowFixture) {
  const module = deferred<unknown>();
  const importer = vi.fn(() => module.promise);
  const loader = new EditorChromeModuleLoader(importer);
  const pending = beginEditorChromeMount(
    createContainer(fixture.document),
    createProps(fixture.document),
    loader,
  );
  return { importer, module, pending };
}

describe("embedded editor chrome loader", () => {
  it("deduplicates one module per owning Window and mounts each root with its latest props", async () => {
    const first = createWindowFixture("first");
    const second = createWindowFixture("second");
    const firstMount = vi.fn(() => ({
      ready: Promise.resolve(true),
      unmount: vi.fn(),
      update: vi.fn(),
    }));
    const secondMount = vi.fn(() => ({
      ready: Promise.resolve(true),
      unmount: vi.fn(),
      update: vi.fn(),
    }));
    const importer = vi.fn(async (_url: string, owningWindow: EditorChromeWindow) => ({
      mountEditorChrome: owningWindow === first.window ? firstMount : secondMount,
    }));
    const loader = new EditorChromeModuleLoader(importer);
    const firstContainer = createContainer(first.document);
    const firstPending = beginEditorChromeMount(
      firstContainer,
      createProps(first.document),
      loader,
    );
    const secondFirstWindowPending = beginEditorChromeMount(
      createContainer(first.document),
      createProps(first.document),
      loader,
    );
    const latest = createProps(first.document, "scrollable");
    firstPending.update(latest);
    const secondWindowPending = beginEditorChromeMount(
      createContainer(second.document),
      createProps(second.document),
      loader,
    );

    await expect(
      Promise.all([firstPending.ready, secondFirstWindowPending.ready, secondWindowPending.ready]),
    ).resolves.toEqual([true, true, true]);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(firstMount).toHaveBeenCalledTimes(2);
    expect(firstMount).toHaveBeenCalledWith(firstContainer, latest);
    expect(secondMount).toHaveBeenCalledOnce();
    expect(first.revoked).toEqual(["blob:first"]);
    expect(second.revoked).toEqual(["blob:second"]);
    expect(first.blobs).toHaveLength(1);
    expect(second.blobs).toHaveLength(1);
  });

  it("does not mount after cancellation while a shared module is loading", async () => {
    const fixture = createWindowFixture("cancelled");
    const mounted = vi.fn(() => ({
      ready: Promise.resolve(true),
      unmount: vi.fn(),
      update: vi.fn(),
    }));
    const { importer, module, pending } = startDeferredMount(fixture);

    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    pending.unmount();
    module.resolve({ mountEditorChrome: mounted });

    await expect(pending.ready).resolves.toBe(false);
    expect(mounted).not.toHaveBeenCalled();
    expect(fixture.revoked).toEqual(["blob:cancelled"]);
  });

  it("waits for the React commit hook and cancels a root that detaches before commit", async () => {
    const fixture = createWindowFixture("commit");
    const committed = deferred<boolean>();
    const unmount = vi.fn();
    const mount = vi.fn(() => ({ ready: committed.promise, unmount, update: vi.fn() }));
    const loader = new EditorChromeModuleLoader(vi.fn(async () => ({ mountEditorChrome: mount })));
    const pending = beginEditorChromeMount(
      createContainer(fixture.document),
      createProps(fixture.document),
      loader,
    );
    await vi.waitFor(() => expect(mount).toHaveBeenCalledOnce());

    pending.unmount();
    committed.resolve(true);

    await expect(pending.ready).resolves.toBe(false);
    expect(unmount).toHaveBeenCalledOnce();
  });
});

describe("embedded editor chrome loader failures", () => {
  it("revokes a failed import and permits an explicit retry", async () => {
    const fixture = createWindowFixture("retry");
    const mounted = vi.fn(() => ({
      ready: Promise.resolve(true),
      unmount: vi.fn(),
      update: vi.fn(),
    }));
    const importer = vi
      .fn()
      .mockRejectedValueOnce(new Error("blocked by script-src"))
      .mockResolvedValueOnce({ mountEditorChrome: mounted });
    const loader = new EditorChromeModuleLoader(importer);

    const failed = beginEditorChromeMount(
      createContainer(fixture.document),
      createProps(fixture.document),
      loader,
    );
    await expect(failed.ready).rejects.toThrow("blocked by script-src");
    const retried = beginEditorChromeMount(
      createContainer(fixture.document),
      createProps(fixture.document),
      loader,
    );

    await expect(retried.ready).resolves.toBe(true);
    expect(importer).toHaveBeenCalledTimes(2);
    expect(fixture.revoked).toEqual(["blob:retry", "blob:retry"]);
  });

  it("rejects a missing decompression API asynchronously before creating a Blob URL", async () => {
    const fixture = createWindowFixture("unsupported");
    const loader = new EditorChromeModuleLoader(vi.fn());
    const unsupported = { ...fixture.window, DecompressionStream: undefined };
    const document = { defaultView: unsupported } as unknown as Document;

    const pending = beginEditorChromeMount(
      createContainer(document),
      createProps(document),
      loader,
    );

    await expect(pending.ready).rejects.toThrow(/embedded module APIs/u);
    expect(fixture.revoked).toEqual([]);
  });

  it("bounds a hung import and releases its Blob URL", async () => {
    const fixture = createWindowFixture("timeout");
    const { importer, module, pending } = startDeferredMount(fixture);

    await vi.waitFor(() => expect(importer).toHaveBeenCalledOnce());
    fixture.runTimers();

    await expect(pending.ready).rejects.toThrow(/timed out/u);
    expect(fixture.revoked).toEqual(["blob:timeout"]);
    module.resolve({ mountEditorChrome: vi.fn() });
  });

  it("rejects and revokes an object URL outside the Blob scheme", async () => {
    const fixture = createWindowFixture("invalid");
    const importer = vi.fn();
    const loader = new EditorChromeModuleLoader(importer);
    const invalidWindow: EditorChromeWindow = {
      ...fixture.window,
      URL: {
        createObjectURL: () => "https://example.invalid/editor.js",
        revokeObjectURL: (url) => fixture.window.URL.revokeObjectURL(url),
      },
    };
    const document = { defaultView: invalidWindow } as unknown as Document;
    const pending = beginEditorChromeMount(
      createContainer(document),
      createProps(document),
      loader,
    );

    await expect(pending.ready).rejects.toThrow(/owned Blob URL/u);
    expect(importer).not.toHaveBeenCalled();
    expect(fixture.revoked).toEqual(["https://example.invalid/editor.js"]);
  });
});
