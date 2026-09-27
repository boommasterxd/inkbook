// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../../src/obsidian/embeds/live-preview";
import { InkbookLoadingPreviewWidget } from "../../../../src/obsidian/embeds/live-preview-loading-widget";
import type { EmbedIntegrationPorts } from "../../../../src/obsidian/embeds/presentation-port";
import { configureTestEditorState } from "../../../adapters/obsidian/plugin";
import { nativeFrameWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

const SAFE_PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>';
const CONTENT_IDENTITY = { outputHash: "a".repeat(64), revision: 1 };

interface RecognitionControl {
  notify: ((documentId: string) => void) | undefined;
  value:
    | false
    | {
        readonly aspectRatio: number;
        readonly contentIdentity: typeof CONTENT_IDENTITY;
        readonly safeSvg: string;
      }
    | undefined;
}

function integrationPorts(control?: RecognitionControl): EmbedIntegrationPorts {
  const disposals = new Map<HTMLElement, () => void>();
  return {
    documents: {
      cached: () =>
        control !== undefined
          ? control.value
          : {
              aspectRatio: 4,
              contentIdentity: CONTENT_IDENTITY,
              safeSvg: SAFE_PREVIEW_SVG,
            },
      recognize: async () => ({
        aspectRatio: 4,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      }),
      subscribe: (listener: (documentId: string) => void) => {
        if (control !== undefined) control.notify = listener;
        return () => {
          if (control !== undefined) control.notify = undefined;
        };
      },
    },
    lifecycle: {
      dispose: (element: HTMLElement) => {
        disposals.get(element)?.();
        disposals.delete(element);
      },
      register: (element: HTMLElement, dispose: () => void) => {
        disposals.set(element, dispose);
        return () => {
          disposals.get(element)?.();
          disposals.delete(element);
        };
      },
    },
    resolveDocument: () => ({
      documentId: "drawings/page.svg",
      resourceUrl: "app://vault/drawings/page.svg",
    }),
    scheme: { subscribe: () => () => undefined },
    sessions: {
      activate: () => undefined,
      detach: () => undefined,
      mount: () => undefined,
    },
    workScheduler: nativeFrameWorkScheduler,
  } as unknown as EmbedIntegrationPorts;
}

describe("Live Preview block-decoration source", () => {
  beforeEach(() => installObsidianDomHelpers());

  afterEach(() => {
    vi.restoreAllMocks();
    removeObsidianDomHelpers();
  });

  it("preserves the active attachment through repeated autosave recognition updates", async () => {
    const control: RecognitionControl = {
      notify: undefined,
      value: { aspectRatio: 4, contentIdentity: CONTENT_IDENTITY, safeSvg: SAFE_PREVIEW_SVG },
    };
    const ports = integrationPorts(control);
    const mount = vi.spyOn(ports.sessions, "mount");
    const detach = vi.spyOn(ports.sessions, "detach");
    const { parent, view } = mountView(ports);
    const attachment = mount.mock.calls[0]![0];
    attachment.root.dataset.inkbookState = "active";
    for (const revision of [2, 3]) {
      control.value = undefined;
      control.notify?.("drawings/page.svg");
      await Promise.resolve();
      control.value = {
        aspectRatio: revision,
        contentIdentity: { outputHash: String(revision).repeat(64), revision },
        safeSvg: SAFE_PREVIEW_SVG,
      };
      control.notify?.("drawings/page.svg");
      await Promise.resolve();
      await attachment.ensurePreviewReady?.();
      expect(parent.querySelector(".inkbook-root")).toBe(attachment.root);
      expect(attachment.root.dataset.inkbookState).toBe("active");
      expect(attachment.previewContentIdentity).toEqual(control.value.contentIdentity);
      expect(
        parent
          .querySelector<HTMLElement>(".inkbook-locked-preview-media")
          ?.style.getPropertyValue("--inkbook-preview-aspect-ratio"),
      ).toBe(String(revision));
    }
    expect(mount).toHaveBeenCalledTimes(1);
    expect(detach).not.toHaveBeenCalled();
    view.destroy();
    expect(detach).toHaveBeenCalledExactlyOnceWith(attachment);
    parent.remove();
  });

  it("provides layout-changing replacements directly from editor state", () => {
    configureTestEditorState({
      file: { path: "notes/note.md" },
      livePreview: true,
    });
    const state = EditorState.create({
      doc: "!inkbook[[drawings/page.svg]]",
      extensions: [
        editorInfoField,
        editorLivePreviewField,
        createLivePreviewExtension(integrationPorts()),
      ],
    });

    const sources = state.facet(EditorView.decorations);
    expect(sources).toHaveLength(1);
    expect(typeof sources[0]).not.toBe("function");
    let replacement: { readonly from: number; readonly to: number } | undefined;
    (sources[0] as DecorationSet).between(0, state.doc.length, (from, to) => {
      replacement = { from, to };
    });
    expect(replacement).toEqual({ from: 0, to: state.doc.length });
  });
});

describe("Live Preview measured height", () => {
  beforeEach(() => installObsidianDomHelpers());
  afterEach(() => {
    vi.restoreAllMocks();
    removeObsidianDomHelpers();
  });

  it.each([600, 7000])("retains a measured %i px block across autosaves", async (height) => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (
      this: HTMLElement,
    ) {
      const measuredHeight = this.classList.contains("inkbook-root")
        ? height
        : this.classList.contains("cm-content")
          ? height + 20
          : 20;
      return new DOMRect(0, 0, 800, measuredHeight);
    });
    const notifyResize = installMeasuredResizeObserver(height);
    const control: RecognitionControl = {
      notify: undefined,
      value: { aspectRatio: 4, contentIdentity: CONTENT_IDENTITY, safeSvg: SAFE_PREVIEW_SVG },
    };
    const ports = integrationPorts(control);
    const detach = vi.spyOn(ports.sessions, "detach");
    const { parent, view } = mountView(ports);
    try {
      await new Promise<void>((resolve) => view.requestMeasure({ read: () => resolve() }));
      expect(view.lineBlockAt(0).height).toBe(height);
      const root = parent.querySelector<HTMLElement>(".inkbook-root")!;
      root.dataset.inkbookState = "active";
      notifyResize(root);
      for (const revision of [2, 3]) {
        control.value = {
          aspectRatio: 4,
          contentIdentity: { outputHash: String(revision).repeat(64), revision },
          safeSvg: SAFE_PREVIEW_SVG,
        };
        control.notify?.("drawings/page.svg");
        await Promise.resolve();
        // Check before the next measure frame can repair the temporary height collapse.
        expect(view.lineBlockAt(0).height).toBe(height);
        expect(parent.querySelector(".inkbook-root")).toBe(root);
        expect(root.dataset.inkbookState).toBe("active");
        expect(detach).not.toHaveBeenCalled();
      }
    } finally {
      view.destroy();
      parent.remove();
    }
  });
});

describe("Live Preview pending recognition", () => {
  beforeEach(() => installObsidianDomHelpers());
  afterEach(() => removeObsidianDomHelpers());

  it.each([true, false])(
    "replaces pending Markdown immediately and resolves valid=%s",
    async (valid) => {
      const control: RecognitionControl = { notify: undefined, value: undefined };
      const ports = integrationPorts(control);
      const recognize = vi.spyOn(ports.documents, "recognize");
      const { parent, view } = mountView(ports);
      expect(parent.querySelector(".inkbook-loading-placeholder")).not.toBeNull();
      expect(parent.querySelector("svg")).toBeNull();
      expect(parent.textContent).not.toContain("!inkbook");
      expect(recognize).not.toHaveBeenCalled();
      await Promise.resolve();
      expect(recognize).toHaveBeenCalledWith("drawings/page.svg");
      control.value = valid
        ? {
            aspectRatio: 4,
            contentIdentity: CONTENT_IDENTITY,
            safeSvg: SAFE_PREVIEW_SVG,
          }
        : false;
      control.notify?.("drawings/page.svg");
      await Promise.resolve();
      expect(parent.querySelector(".inkbook-loading-placeholder")).toBeNull();
      if (valid) expect(parent.querySelector(".inkbook-locked-preview")).not.toBeNull();
      else expect(parent.textContent).toContain("!inkbook[[drawings/page.svg]]");
      view.destroy();
      expect(control.notify).toBeUndefined();
      parent.remove();
    },
  );
});

describe("Live Preview pending lifecycle", () => {
  beforeEach(() => installObsidianDomHelpers());
  afterEach(() => {
    vi.restoreAllMocks();
    removeObsidianDomHelpers();
  });

  it("retains the animated pending height across remount and cancels owned frame work", async () => {
    const ports = integrationPorts({ notify: undefined, value: undefined });
    const recognize = vi.spyOn(ports.documents, "recognize");
    const token = { presented: false, initialHeight: 0 };
    const widget = new InkbookLoadingPreviewWidget("drawing.svg", ports, token);
    const frame = vi.spyOn(window, "requestAnimationFrame").mockReturnValue(12);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const view = { dom: document.body } as EditorView;
    const first = widget.toDOM(view);
    expect(token.initialHeight).toBe(0);
    frame.mock.calls[0]?.[0](0);
    frame.mock.calls[1]?.[0](90);
    expect(token.initialHeight).toBe(24);
    widget.destroy(first);
    expect(cancel).toHaveBeenCalledWith(12);
    expect(token.presented).toBe(false);
    const second = widget.toDOM(view);
    expect(token.initialHeight).toBe(24);
    widget.destroy(second);
    await Promise.resolve();
    expect(recognize).not.toHaveBeenCalled();
    expect(token.presented).toBe(false);
    expect(widget.eq(new InkbookLoadingPreviewWidget("drawing.svg", ports, token))).toBe(true);
    expect(widget.eq(new InkbookLoadingPreviewWidget("other.svg", ports, token))).toBe(false);
  });

  it("retains the mounted block while a saved SVG is being reclassified", async () => {
    const control: RecognitionControl = {
      notify: undefined,
      value: {
        aspectRatio: 4,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      },
    };
    const { parent, view } = mountView(integrationPorts(control));
    const mounted = parent.querySelector(".inkbook-root");
    expect(mounted).not.toBeNull();

    control.value = undefined;
    control.notify?.("drawings/page.svg");
    await Promise.resolve();

    expect(parent.querySelector(".inkbook-root")).toBe(mounted);

    control.value = false;
    control.notify?.("drawings/page.svg");
    await Promise.resolve();

    expect(parent.querySelector(".inkbook-root")).toBeNull();
    view.destroy();
    parent.remove();
  });

  it("coalesces relevant recognition notifications and ignores queued work after destruction", async () => {
    const control: RecognitionControl = { notify: undefined, value: undefined };
    const ports = integrationPorts(control);
    const { parent, view } = mountView(ports);
    const dispatch = vi.spyOn(view, "dispatch");
    const resolve = vi.spyOn(ports, "resolveDocument");
    control.notify?.("elsewhere.svg");
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    control.value = false;
    control.notify?.("drawings/page.svg");
    control.notify?.("drawings/page.svg");
    expect(dispatch).not.toHaveBeenCalled();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(resolve).not.toHaveBeenCalled();
    expect(parent.querySelector(".inkbook-root")).toBeNull();
    control.notify?.("drawings/page.svg");
    view.destroy();
    await Promise.resolve();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(control.notify).toBeUndefined();
    parent.remove();
  });

  it("drops queued recognition when its embed was removed before the batch flush", async () => {
    const control: RecognitionControl = { notify: undefined, value: undefined };
    const { parent, view } = mountView(integrationPorts(control));
    control.notify?.("drawings/page.svg");
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Ordinary prose" } });
    const dispatch = vi.spyOn(view, "dispatch");
    await Promise.resolve();
    expect(dispatch).not.toHaveBeenCalled();
    expect(parent.querySelector(".inkbook-root")).toBeNull();
    view.destroy();
    parent.remove();
  });
});

function mountView(ports: EmbedIntegrationPorts) {
  configureTestEditorState({ file: { path: "notes/note.md" }, livePreview: true });
  const parent = document.body.createDiv();
  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: "!inkbook[[drawings/page.svg]]",
      extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
    }),
  });
  return { parent, view };
}

function installObsidianDomHelpers(): void {
  Object.defineProperties(HTMLElement.prototype, {
    createDiv: {
      configurable: true,
      value(this: HTMLElement, options?: { readonly cls?: string }) {
        const element = createOwnedElement(this, "div");
        if (options?.cls !== undefined) element.className = options.cls;
        this.append(element);
        return element;
      },
    },
    createEl: {
      configurable: true,
      value(
        this: HTMLElement,
        tag: string,
        options?: { readonly attr?: Record<string, string>; readonly cls?: string },
      ) {
        const element = createOwnedElement(this, tag);
        if (options?.cls !== undefined) element.className = options.cls;
        for (const [name, value] of Object.entries(options?.attr ?? {})) {
          element.setAttribute(name, value);
        }
        this.append(element);
        return element;
      },
    },
    setCssProps: {
      configurable: true,
      value(this: HTMLElement, properties: Record<string, string>) {
        for (const [name, value] of Object.entries(properties)) this.style.setProperty(name, value);
      },
    },
  });
}

function createOwnedElement(owner: HTMLElement, tag: string): HTMLElement {
  const factory = Reflect.get(owner.ownerDocument, "createElement");
  return Reflect.apply(factory, owner.ownerDocument, [tag]);
}

function removeObsidianDomHelpers(): void {
  Reflect.deleteProperty(HTMLElement.prototype, "createDiv");
  Reflect.deleteProperty(HTMLElement.prototype, "createEl");
  Reflect.deleteProperty(HTMLElement.prototype, "setCssProps");
  document.body.replaceChildren();
}

function installMeasuredResizeObserver(height: number): (target: Element) => void {
  const observations = new Map<Element, Map<ResizeObserver, () => void>>();
  vi.spyOn(window, "ResizeObserver").mockImplementation(
    class implements ResizeObserver {
      readonly #targets = new Set<Element>();
      constructor(readonly callback: ResizeObserverCallback) {}
      observe(target: Element): void {
        this.#targets.add(target);
        const listeners = observations.get(target) ?? new Map<ResizeObserver, () => void>();
        observations.set(target, listeners);
        listeners.set(this, () => {
          this.callback(
            [
              {
                target,
                borderBoxSize: [{ blockSize: height, inlineSize: 800 }],
                contentRect: new DOMRect(0, 0, 800, height),
              } as unknown as ResizeObserverEntry,
            ],
            this,
          );
        });
      }
      unobserve(target: Element): void {
        observations.get(target)?.delete(this);
        this.#targets.delete(target);
      }
      disconnect(): void {
        for (const target of this.#targets) observations.get(target)?.delete(this);
        this.#targets.clear();
      }
    },
  );
  return (target) => {
    for (const notify of observations.get(target)?.values() ?? []) notify();
  };
}
