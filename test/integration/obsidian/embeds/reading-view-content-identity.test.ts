import { describe, expect, it, vi } from "vitest";

import type { InkbookDocumentRecognitionPort } from "../../../../src/obsidian/embeds/preview/document-recognition";
import { createReadingViewPostProcessor } from "../../../../src/obsidian/embeds/reading-view";
import type {
  EmbedIntegrationPorts,
  PresentationAttachment,
} from "../../../../src/obsidian/embeds/presentation/presentation-port";
import { PresentationLifecycleRegistry } from "../../../../src/obsidian/embeds/presentation/presentation-lifecycle-registry";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { nativeFrameWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

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

describe("Reading-view native recognition", () => {
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
