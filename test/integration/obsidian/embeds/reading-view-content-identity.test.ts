import { describe, expect, it, vi } from "vitest";

import type { InkbookDocumentRecognitionPort } from "../../../../src/obsidian/embeds/document-recognition";
import { createReadingViewPostProcessor } from "../../../../src/obsidian/embeds/reading-view";
import type {
  EmbedIntegrationPorts,
  PresentationAttachment,
} from "../../../../src/obsidian/embeds/presentation-port";
import { PresentationLifecycleRegistry } from "../../../../src/obsidian/embeds/presentation-lifecycle-registry";
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

describe("Reading-view preview content identity", () => {
  it("keeps a detached postprocessor host mountable and restores its exact children once", () => {
    const documents: InkbookDocumentRecognitionPort = {
      cached: () => FIRST_PREVIEW,
      recognize: async () => FIRST_PREVIEW,
      subscribe: () => () => undefined,
    };
    const harness = mountReadingView(documents, true);
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
    let current: typeof FIRST_PREVIEW | false = FIRST_PREVIEW;
    let listener: ((documentId: string) => void) | undefined;
    const harness = mountReadingView({
      cached: () => current,
      recognize: async () => current,
      subscribe: (callback) => {
        listener = callback;
        return () => {
          listener = undefined;
        };
      },
    });
    current = false;
    listener?.("drawings/ink.svg");
    await vi.waitFor(() => expect(harness.root.children).toEqual(harness.originalChildren));
    expect(harness.section.children).toEqual([harness.root]);
    expect(listener).toBeUndefined();
  });

  it("refreshes a mounted preview from the latest recognized identity", async () => {
    let current = FIRST_PREVIEW;
    let listener: ((documentId: string) => void) | undefined;
    const documents: InkbookDocumentRecognitionPort = {
      cached: () => current,
      recognize: async () => current,
      subscribe: (nextListener) => {
        listener = nextListener;
        return () => {
          listener = undefined;
        };
      },
    };
    const harness = mountReadingView(documents);
    expect(harness.previewMedia.style["--inkbook-preview-aspect-ratio"]).toBe("12");

    current = SECOND_PREVIEW;
    listener?.("drawings/ink.svg");

    await vi.waitFor(() =>
      expect(harness.previewMedia.style["--inkbook-preview-aspect-ratio"]).toBe("4"),
    );
    expect(harness.attachments[0]?.previewContentIdentity).toEqual(SECOND_PREVIEW.contentIdentity);
    harness.child?.unload();
  });
});

describe("Reading-view pending recognition", () => {
  it("immediately hides source until a validated preview adopts the placeholder", async () => {
    const harness = pendingReadingView();
    expect(harness.root.children[0]?.classNames).toContain("inkbook-loading-placeholder");
    expect(harness.attachments).toEqual([]);
    harness.resolve(FIRST_PREVIEW);
    await harness.processing;
    expect(harness.root.children[0]?.classNames).toContain("inkbook-root");
    expect(harness.attachments).toHaveLength(1);
    harness.children[0]?.unload();
    expect(harness.root.children[0]?.classNames).toContain("inkbook-root");
    harness.children[1]?.unload();
    expect(harness.root.children).toEqual([harness.original]);
  });

  it.each([0, 90])(
    "adopts the visible placeholder height after %i ms without a 48px jump",
    async (elapsed) => {
      const frames: FrameRequestCallback[] = [];
      const harness = pendingReadingView((root) => {
        vi.spyOn(root.ownerDocument.defaultView!, "requestAnimationFrame").mockImplementation(
          (callback) => {
            frames.push(callback);
            return frames.length;
          },
        );
      });
      for (const frame of frames.splice(0)) frame(0);
      if (elapsed > 0) for (const frame of frames.splice(0)) frame(elapsed);
      harness.resolve(FIRST_PREVIEW);
      await harness.processing;
      const root = harness.attachments[0]?.root;
      expect(Reflect.get(root!.style, "--inkbook-presentation-block-size")).toBe(
        `${String(elapsed === 0 ? 0 : 24)}px`,
      );
      for (const child of harness.children) child.unload();
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
      await harness.processing;
      expect(harness.root.children).toEqual([harness.original]);
      expect(harness.attachments).toEqual([]);
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
    const root = new FakePresentationElement();
    const addChild = vi.fn((child: { load(): void }) => child.load());
    const processing = createReadingViewPostProcessor(createPorts(documents, []))(
      root as unknown as HTMLElement,
      readingContext(addChild),
    );

    cached = SECOND_PREVIEW;
    resolveRecognition(FIRST_PREVIEW);
    await processing;

    expect(addChild).toHaveBeenCalledTimes(1);
    expect(root.children).toEqual([]);
  });
});

function mountReadingView(documents: InkbookDocumentRecognitionPort, detached = false) {
  const attachments: PresentationAttachment[] = [];
  const section = new FakePresentationElement();
  const root = new FakePresentationElement(section.ownerDocument);
  if (!detached) section.append(root);
  else root.isConnected = false;
  const originalChildren = [
    new FakePresentationElement(root.ownerDocument, "span"),
    new FakePresentationElement(root.ownerDocument, "a"),
  ];
  for (const original of originalChildren) root.append(original);
  let child: { readonly containerEl?: HTMLElement; load(): void; unload(): void } | undefined;
  void createReadingViewPostProcessor(createPorts(documents, attachments))(
    root as unknown as HTMLElement,
    readingContext((nextChild: { load(): void; unload(): void }) => {
      child = nextChild;
      nextChild.load();
    }),
  );
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
      text: "!inkbook[[drawings/ink.svg]]",
    }),
    addChild,
  } as never;
}

function pendingReadingView(prepare?: (root: FakePresentationElement) => void) {
  type Result = typeof FIRST_PREVIEW | false;
  let cached: Result | undefined;
  let resolvePromise!: (result: Result) => void;
  let reject!: (error: Error) => void;
  const recognition = new Promise<Result>((resolve, rejectPromise) => {
    resolvePromise = resolve;
    reject = rejectPromise;
  });
  const attachments: PresentationAttachment[] = [];
  const ports = createPorts(
    {
      cached: () => cached,
      recognize: () => recognition,
      subscribe: () => () => undefined,
    },
    attachments,
  );
  const root = new FakePresentationElement();
  const original = new FakePresentationElement(root.ownerDocument, "span");
  root.append(original);
  prepare?.(root);
  const children: { load(): void; unload(): void }[] = [];
  const context = {
    sourcePath: "notes/note.md",
    getSectionInfo: () => ({ lineStart: 0, lineEnd: 0, text: "!inkbook[[drawings/ink.svg]]" }),
    addChild: (child: { load(): void; unload(): void }) => {
      children.push(child);
      child.load();
    },
  };
  const processing = createReadingViewPostProcessor(ports)(
    root as unknown as HTMLElement,
    context as never,
  );
  return {
    attachments,
    children,
    original,
    ports,
    processing,
    reject,
    root,
    changeSource: () => {
      context.sourcePath = "notes/other.md";
    },
    resolve: (result: Result) => {
      cached = result;
      resolvePromise(result);
    },
  };
}
