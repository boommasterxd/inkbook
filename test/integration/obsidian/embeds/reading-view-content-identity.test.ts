import { describe, expect, it, vi } from "vitest";

import type { InkbookDocumentRecognitionPort } from "../../../../src/obsidian/embeds/preview/document-recognition";
import { createReadingViewPostProcessor } from "../../../../src/obsidian/embeds/reading-view";
import * as previewBuilder from "../../../../src/obsidian/embeds/preview/safe-preview-builder";
import type {
  EmbedIntegrationPorts,
  PresentationAttachment,
} from "../../../../src/obsidian/embeds/presentation/presentation-port";
import { PresentationLifecycleRegistry } from "../../../../src/obsidian/embeds/presentation/presentation-lifecycle-registry";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { nativeFrameWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import { createHiddenPreviewHandoff } from "../../../fixtures/obsidian/active-preview-handoff";

const SAFE_PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>';
const FIRST_PREVIEW = {
  aspectRatio: 12,
  contentIdentity: { outputHash: "a".repeat(64), revision: 1 },
  safeSvg: SAFE_PREVIEW_SVG,
};
const SECOND_PREVIEW = {
  aspectRatio: 4,
  contentIdentity: { outputHash: "b".repeat(64), revision: 2 },
  safeSvg: SAFE_PREVIEW_SVG,
};

describe("Reading-view preview content identity", () => {
  it("keeps a detached postprocessor host mountable and restores its exact children once", async () => {
    const documents: InkbookDocumentRecognitionPort = {
      cached: () => FIRST_PREVIEW,
      recognize: async () => FIRST_PREVIEW,
      subscribe: () => () => undefined,
    };
    const harness = await mountReadingView(documents, true);
    expect(harness.section.children).toEqual([]);
    expect(harness.child?.containerEl).toBe(harness.root);
    harness.section.append(harness.root);
    expect(harness.root.children[0]?.classNames).toContain("inkbook-root");
    harness.child?.unload();
    harness.child?.unload();
    expect(harness.section.children).toEqual([harness.root]);
    expect(harness.root.children).toEqual(harness.originalChildren);
  });

  it("restores original source nodes when recognition becomes invalid", async () => {
    const recognition = mutableRecognition();
    const harness = await mountReadingView(recognition.documents);
    recognition.update(false);
    await vi.waitFor(() => expect(harness.root.children).toEqual(harness.originalChildren));
    expect(harness.section.children).toEqual([harness.root]);
    harness.child?.unload();
    expect(recognition.listeners.size).toBe(0);
  });

  it("refreshes a mounted preview from the latest recognized identity", async () => {
    const recognition = mutableRecognition();
    const harness = await mountReadingView(recognition.documents);
    expect(harness.previewMedia.style["--inkbook-preview-aspect-ratio"]).toBe("12");

    recognition.update(SECOND_PREVIEW);

    await vi.waitFor(() =>
      expect(harness.previewMedia.style["--inkbook-preview-aspect-ratio"]).toBe("4"),
    );
    expect(harness.attachments[0]?.previewContentIdentity).toEqual(SECOND_PREVIEW.contentIdentity);
    harness.child?.unload();
  });
});

describe("Reading-view active preview refresh", () => {
  it("refreshes a visible sibling while deferring the hidden active preview", async () => {
    const recognition = mutableRecognition();
    const active = await mountReadingView(recognition.documents);
    const sibling = await mountReadingView(recognition.documents);
    const attachment = active.attachments[0]!;
    await sibling.attachments[0]!.ensurePreviewReady?.();
    const { handoff } = await createHiddenPreviewHandoff(
      attachment,
      nativeFrameWorkScheduler(attachment.root.ownerDocument.defaultView),
    );
    const activeSurface = active.previewMedia.shadowRoot as unknown as FakePresentationElement;
    expect(activeSurface.getElementsByTagName("iframe").length).toBe(0);
    const builder = vi.spyOn(previewBuilder, "createPreviewSvgAsync");
    try {
      recognition.update(SECOND_PREVIEW);
      await vi.waitFor(() =>
        expect(sibling.previewMedia.style["--inkbook-preview-aspect-ratio"]).toBe("4"),
      );
      expect(attachment.previewContentIdentity).toEqual(SECOND_PREVIEW.contentIdentity);
      expect(active.previewMedia.style["--inkbook-preview-aspect-ratio"]).toBe("12");
      expect(builder).toHaveBeenCalledOnce();
      const surface = sibling.previewMedia.shadowRoot as unknown as FakePresentationElement;
      const frame = surface.getElementsByTagName("iframe").item(0)!;
      expect(builder.mock.calls[0]?.[0]).toBe(frame.contentDocument);
      await handoff.ensurePreviewReady();
      expect(activeSurface.getElementsByTagName("iframe").length).toBe(1);
      handoff.restorePreview();
      expect(active.previewMedia.style["--inkbook-preview-aspect-ratio"]).toBe("4");
      expect(builder).toHaveBeenCalledTimes(2);
    } finally {
      builder.mockRestore();
      handoff.dispose();
      active.child?.unload();
      sibling.child?.unload();
    }
    expect(recognition.listeners.size).toBe(0);
  });
});

describe("Reading-view native recognition", () => {
  it("applies a native width only after validation and leaves the native source intact on unload", async () => {
    const harness = pendingReadingView("![Drawing|400](drawings/ink.svg)");
    expect(harness.root.children).toEqual([harness.original]);
    harness.resolve(FIRST_PREVIEW);
    await vi.waitFor(() => expect(harness.attachments).toHaveLength(1));
    const attachment = harness.attachments[0]!;
    expect(Reflect.get(attachment.root.style, "--inkbook-embed-inline-size")).toBe("400px");
    harness.ports.lifecycle.disposeAll();
    expect(harness.root.children).toEqual([harness.original]);
  });

  it("keeps a native image until validation and restores it across invalidation and unload", async () => {
    const harness = pendingReadingView("![Drawing](drawings/ink.svg)");
    expect(harness.root.children).toEqual([harness.original]);
    expect(harness.attachments).toHaveLength(0);
    harness.resolve(false);
    await harness.settled();
    expect(harness.recognize).toHaveBeenCalled();
    expect(harness.root.children).toEqual([harness.original]);
    harness.update(FIRST_PREVIEW);
    await vi.waitFor(() => expect(harness.attachments).toHaveLength(1));
    expect(harness.root.children).not.toContain(harness.original);
    harness.update(false);
    await vi.waitFor(() => expect(harness.root.children).toEqual([harness.original]));
    harness.update(SECOND_PREVIEW);
    await vi.waitFor(() => expect(harness.attachments).toHaveLength(2));
    harness.ports.lifecycle.disposeAll();
    expect(harness.root.children).toEqual([harness.original]);
    expect(harness.recognitionListeners.size).toBe(0);
  });
});

describe("Reading-view pending recognition", () => {
  it.each([
    { text: "![[drawings/other.svg]]", line: 0 },
    { text: "Before\n![[drawings/ink.svg]]", line: 1 },
    { text: "<!--\n![[drawings/ink.svg]]\n-->", line: 1 },
  ])(
    "rechecks fresh source syntax and offsets after pending recognition: $text",
    async ({ text, line }) => {
      const harness = pendingReadingView();
      harness.changeMarkdown(text, line);
      harness.resolve(FIRST_PREVIEW);
      await harness.settled();
      expect(harness.root.children).toEqual([harness.original]);
      expect(harness.attachments).toEqual([]);
      expect(harness.recognitionListeners.size).toBe(0);
      harness.ports.lifecycle.disposeAll();
    },
  );

  it.each(["invalid", "rejected", "unloaded", "disposed", "changed"] as const)(
    "restores source without adopting a preview when recognition is %s",
    async (outcome) => {
      const harness = pendingReadingView();
      if (outcome === "unloaded") harness.children[0]?.unload();
      if (outcome === "disposed") harness.ports.lifecycle.disposeAll();
      if (outcome === "changed") harness.changeSource();
      if (outcome === "rejected") harness.reject(new Error("Read failed"));
      else harness.resolve(outcome === "invalid" ? false : FIRST_PREVIEW);
      await harness.settled();
      expect(harness.root.children).toEqual([harness.original]);
      expect(harness.attachments).toEqual([]);
      harness.ports.lifecycle.disposeAll();
      expect(harness.recognitionListeners.size).toBe(0);
    },
  );

  it("rejects a stale asynchronous recognition before mounting", async () => {
    let resolveRecognition!: (value: typeof FIRST_PREVIEW) => void;
    let cached: typeof FIRST_PREVIEW | typeof SECOND_PREVIEW | undefined;
    const recognition = new Promise<typeof FIRST_PREVIEW>((resolve) => {
      resolveRecognition = resolve;
    });
    const documents: InkbookDocumentRecognitionPort = {
      cached: () => cached,
      recognize: () => recognition,
      subscribe: () => () => undefined,
    };
    const root = new FakePresentationElement(undefined, "p");
    const original = nativeImage(root);
    const addChild = vi.fn((child: { load(): void }) => child.load());
    const ports = createPorts(documents, []);
    void createReadingViewPostProcessor(ports)(
      root as unknown as HTMLElement,
      readingContext(addChild),
    );

    cached = SECOND_PREVIEW;
    resolveRecognition(FIRST_PREVIEW);
    await recognition;
    await Promise.resolve();
    await Promise.resolve();

    expect(addChild).toHaveBeenCalledTimes(1);
    expect(root.children).toEqual([original]);
    ports.lifecycle.disposeAll();
  });
});

function mutableRecognition() {
  let current: typeof FIRST_PREVIEW | false = FIRST_PREVIEW;
  const listeners = new Set<(documentId: string) => void>();
  const documents: InkbookDocumentRecognitionPort = {
    cached: () => current,
    recognize: async () => current,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    documents,
    listeners,
    update: (preview: typeof FIRST_PREVIEW | false) => {
      current = preview;
      for (const listener of listeners) listener("drawings/ink.svg");
    },
  };
}

async function mountReadingView(documents: InkbookDocumentRecognitionPort, detached = false) {
  const attachments: PresentationAttachment[] = [];
  const section = new FakePresentationElement();
  const root = new FakePresentationElement(section.ownerDocument, "p");
  if (!detached) section.append(root);
  else root.isConnected = false;
  const originalChildren = [nativeImage(root)];
  let child: { readonly containerEl?: HTMLElement; load(): void; unload(): void } | undefined;
  void createReadingViewPostProcessor(createPorts(documents, attachments))(
    root as unknown as HTMLElement,
    readingContext((nextChild: { load(): void; unload(): void }) => {
      child = nextChild;
      nextChild.load();
    }),
  );
  await vi.waitFor(() => expect(attachments).toHaveLength(1));
  const previewMedia = root.children[0]?.children[0]?.children[0];
  if (previewMedia === undefined) throw new Error("The Reading-view preview was not mounted.");
  return { attachments, child, originalChildren, previewMedia, root, section };
}

function createPorts(
  documents: InkbookDocumentRecognitionPort,
  attachments: PresentationAttachment[],
): EmbedIntegrationPorts {
  return {
    documents,
    lifecycle: new PresentationLifecycleRegistry(),
    resolveDocument: () => ({
      documentId: "drawings/ink.svg",
      resourceUrl: "app://vault/drawings/ink.svg",
    }),
    scheme: new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    sessions: {
      activate: () => undefined,
      detach: () => undefined,
      mount: (attachment) => attachments.push(attachment),
    },
    workScheduler: nativeFrameWorkScheduler,
  };
}

function readingContext(addChild: (child: never) => void) {
  return {
    sourcePath: "notes/note.md",
    getSectionInfo: () => ({
      lineEnd: 0,
      lineStart: 0,
      text: "![[drawings/ink.svg]]",
    }),
    addChild,
  } as never;
}

function pendingReadingView(markdown = "![[drawings/ink.svg]]") {
  type Result = typeof FIRST_PREVIEW | false;
  let cached: Result | undefined;
  let resolvePromise!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const recognition = new Promise<Result>((resolve, rejectPromise) => {
    resolvePromise = resolve;
    reject = rejectPromise;
  });
  const recognize = vi.fn(() => (cached === undefined ? recognition : Promise.resolve(cached)));
  const recognitionListeners = new Set<(documentId: string) => void>();
  const attachments: PresentationAttachment[] = [];
  const ports = createPorts(
    {
      cached: () => cached,
      recognize,
      subscribe: (listener) => {
        recognitionListeners.add(listener);
        return () => recognitionListeners.delete(listener);
      },
    },
    attachments,
  );
  const root = new FakePresentationElement(undefined, "p");
  const original = nativeImage(root, markdown);
  const children: { load(): void; unload(): void }[] = [];
  let line = 0;
  const context = {
    sourcePath: "notes/note.md",
    getSectionInfo: () => ({ lineStart: line, lineEnd: line, text: markdown }),
    addChild: (child: { load(): void; unload(): void }) => {
      children.push(child);
      child.load();
    },
  };
  void createReadingViewPostProcessor(ports)(root as unknown as HTMLElement, context as never);
  return {
    attachments,
    children,
    original,
    ports,
    recognize,
    recognitionListeners,
    settled: async () => {
      await recognition.catch(() => undefined);
      await Promise.resolve();
      await Promise.resolve();
    },
    update: (value: Result) => {
      cached = value;
      for (const listener of recognitionListeners) listener("drawings/ink.svg");
    },
    reject,
    root,
    changeSource: () => {
      context.sourcePath = "notes/other.md";
    },
    changeMarkdown: (text: string, nextLine = 0) => {
      markdown = text;
      line = nextLine;
    },
    resolve: (result: Result) => {
      cached = result;
      resolvePromise(result);
    },
  };
}

function nativeImage(root: FakePresentationElement, markdown = "![[drawings/ink.svg]]") {
  const span = root.createEl("span");
  const description = markdown.startsWith("![[") ? "drawings/ink.svg" : "Drawing";
  span.createEl("img", {
    attr: {
      src: "app://vault/drawings/ink.svg",
      alt: description,
      ...(markdown.includes("|400") ? { width: "400" } : {}),
    },
  });
  return span;
}
