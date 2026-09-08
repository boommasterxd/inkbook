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
    const addChild = vi.fn();
    const processing = createReadingViewPostProcessor(createPorts(documents, []))(
      root as unknown as HTMLElement,
      readingContext(addChild),
    );

    cached = SECOND_PREVIEW;
    resolveRecognition(FIRST_PREVIEW);
    await processing;

    expect(addChild).not.toHaveBeenCalled();
  });
});

function mountReadingView(documents: InkbookDocumentRecognitionPort) {
  const attachments: PresentationAttachment[] = [];
  const section = new FakePresentationElement();
  const root = new FakePresentationElement(section.ownerDocument);
  section.append(root);
  let child: { load(): void; unload(): void } | undefined;
  void createReadingViewPostProcessor(createPorts(documents, attachments))(
    root as unknown as HTMLElement,
    readingContext((nextChild: { load(): void; unload(): void }) => {
      child = nextChild;
      nextChild.load();
    }),
  );
  const previewMedia = section.children[0]?.children[0]?.children[0];
  if (previewMedia === undefined) throw new Error("The Reading-view preview was not mounted.");
  return { attachments, child, previewMedia };
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
  };
}

function readingContext(addChild: (child: never) => void) {
  return {
    sourcePath: "notes/note.md",
    getSectionInfo: () => ({
      lineEnd: 1,
      lineStart: 1,
      text: "!inkbook[[drawings/ink.svg]]",
    }),
    addChild,
  } as never;
}
