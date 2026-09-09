import { InkbookLivePreviewWidget } from "../../../../src/obsidian/embeds/live-preview-widget";
import { describe, expect, it, vi } from "vitest";

import {
  createReadingViewPostProcessor,
  findMarkdownInkbookEmbeds,
  MARKDOWN_EMBED_LIMITS,
  PresentationLifecycleRegistry,
  shouldRefreshLivePreview,
  type EmbedIntegrationPorts,
} from "../../../../src/obsidian/embeds";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement as FakeElement } from "../../../fixtures/obsidian/presentation-dom";

const SAFE_PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>';
const CONTENT_IDENTITY = { outputHash: "a".repeat(64), revision: 1 };

function livePreviewEmbed(resourceUrl = "app://vault/ink.svg") {
  return {
    from: 4,
    preview: { aspectRatio: 12, contentIdentity: CONTENT_IDENTITY, safeSvg: SAFE_PREVIEW_SVG },
    resolved: { documentId: "drawings/ink.svg", resourceUrl },
    sourcePath: "notes/note.md",
    to: 28,
  };
}
function createPorts(): EmbedIntegrationPorts & {
  readonly attachments: Array<{
    readonly embedReference: unknown;
    readonly preview?: HTMLElement;
    readonly previewContentIdentity?: typeof CONTENT_IDENTITY;
    readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  }>;
  readonly calls: string[];
  readonly setDark: () => void;
} {
  let dark = false;
  const calls: string[] = [];
  const attachments: Array<{
    readonly embedReference: unknown;
    readonly preview?: HTMLElement;
    readonly previewContentIdentity?: typeof CONTENT_IDENTITY;
    readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  }> = [];
  return {
    attachments,
    calls,
    documents: {
      cached: () => ({
        aspectRatio: 12,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      }),
      recognize: async () => ({
        aspectRatio: 12,
        contentIdentity: CONTENT_IDENTITY,
        safeSvg: SAFE_PREVIEW_SVG,
      }),
      subscribe: () => () => undefined,
    },
    lifecycle: new PresentationLifecycleRegistry(),
    resolveDocument: (linkpath) =>
      linkpath === "drawings/ink.svg"
        ? { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" }
        : undefined,
    scheme: new ColorSchemeBroadcaster({ getColorScheme: () => (dark ? "dark" : "light") }),
    sessions: {
      activate: (attachment) => calls.push(`activate:${attachment.documentId}`),
      detach: (attachment) => calls.push(`detach:${attachment.documentId}`),
      mount: (attachment) => {
        attachments.push(attachment);
        calls.push(`mount:${attachment.documentId}`);
      },
    },
    setDark: () => {
      dark = true;
    },
  };
}
function requireOwnedPreview(
  root: FakeElement,
  activationButton: FakeElement | undefined,
): FakeElement {
  expect(activationButton?.tagName).toBe("BUTTON");
  expect(activationButton?.attributes.get("aria-label")).toBe("Edit handwriting");
  expect(activationButton?.attributes.get("type")).toBe("button");
  expect(activationButton?.children[0]?.classNames).toContain("inkbook-locked-preview-media");
  expect(root.getElementsByTagName("img").length).toBe(0);
  if (activationButton === undefined) throw new Error("Missing activation button.");
  return activationButton;
}
describe("Markdown embed recognition", () => {
  it("parses standalone Inkbook embeds without treating native SVG embeds as ink", () => {
    expect(
      findMarkdownInkbookEmbeds(
        [
          "!inkbook[[drawings/ink.svg|600]]",
          "!inkbook[preview](other.svg)",
          "![[drawings/native.svg]]",
          "![preview](native.svg)",
          "![[note.md]]",
        ].join("\n"),
      ),
    ).toMatchObject([
      { linkpath: "drawings/ink.svg", markdown: "!inkbook[[drawings/ink.svg|600]]" },
      { linkpath: "other.svg", markdown: "!inkbook[preview](other.svg)" },
    ]);
  });

  it("ignores embed-like text in code, comments, and escaped Markdown", () => {
    const markdown = [
      "`!inkbook[[drawings/ink.svg]]`",
      "```md",
      "!inkbook[[drawings/ink.svg]]",
      "```",
      "<!-- !inkbook[preview](drawings/ink.svg) -->",
      String.raw`\!inkbook[[drawings/ink.svg]]`,
      "!inkbook[[drawings/ink.svg]]",
      "!inkbook[preview](drawings/ink.svg)",
    ].join("\n");

    expect(findMarkdownInkbookEmbeds(markdown).map((embed) => embed.markdown)).toEqual([
      "!inkbook[[drawings/ink.svg]]",
      "!inkbook[preview](drawings/ink.svg)",
    ]);
  });

  it("fails closed before matching an oversized UTF-8 Markdown section", () => {
    const oversized = `${"x".repeat(MARKDOWN_EMBED_LIMITS.inputBytes)}é`;

    expect(findMarkdownInkbookEmbeds(oversized)).toEqual([]);
  });
  it("fails closed before accumulating too many Markdown matches", () => {
    const tooManyEmbeds = Array.from(
      { length: MARKDOWN_EMBED_LIMITS.matches + 1 },
      () => "!inkbook[[drawings/ink.svg]]",
    ).join("\n");

    expect(findMarkdownInkbookEmbeds(tooManyEmbeds)).toEqual([]);
  });
});
describe("Reading-view embed lifecycle", () => {
  it("leaves Reading view unchanged when public context is ambiguous", () => {
    const ports = createPorts();
    const root = new FakeElement();
    root.append(new FakeElement(root.ownerDocument, "img"));
    const addChild = vi.fn();
    const processor = createReadingViewPostProcessor(ports);

    void processor(
      root as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => null,
        addChild,
      } as never,
    );
    expect(addChild).not.toHaveBeenCalled();

    void processor(
      root as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({
          lineEnd: 0,
          lineStart: 0,
          text: "!inkbook[[drawings/ink.svg]] !inkbook[[drawings/ink.svg]]",
        }),
        addChild,
      } as never,
    );
    expect(addChild).not.toHaveBeenCalled();
    expect(ports.calls).toEqual([]);
  });
  it("replaces the complete custom Reading-view block", () => {
    const ports = createPorts();
    const section = new FakeElement();
    const root = new FakeElement(section.ownerDocument);
    section.append(root);
    const markerText = new FakeElement(root.ownerDocument, "span");
    const fileLink = new FakeElement(root.ownerDocument, "a");
    root.append(markerText);
    root.append(fileLink);
    const processor = createReadingViewPostProcessor(ports);
    let child: { load(): void; unload(): void } | undefined;

    void processor(
      root as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({
          lineEnd: 3,
          lineStart: 3,
          text: "Before\n\n\n!inkbook[[drawings/ink.svg]]\n\nAfter",
        }),
        addChild: (nextChild: { load(): void; unload(): void }) => {
          child = nextChild;
          nextChild.load();
        },
      } as never,
    );

    expect(ports.calls).toEqual(["mount:drawings/ink.svg"]);
    const ownedRoot = root.children[0];
    expect(ownedRoot?.tagName).toBe("DIV");
    expect(ownedRoot?.classNames).toContain("inkbook-root");
    expect(section.classNames).toContain("inkbook-scrollbar-stable");
    expect(ownedRoot?.style.colorScheme).toBe("light");
    const activationButton = requireOwnedPreview(ownedRoot ?? root, ownedRoot?.children[0]);
    expect(root.isConnected).toBe(true);
    expect(section.children).toEqual([root]);
    expect(ports.attachments[0]?.embedReference).toEqual({
      documentId: "drawings/ink.svg",
      kind: "reading-view",
      markdown: "!inkbook[[drawings/ink.svg]]",
      section: {
        lineEnd: 3,
        lineStart: 3,
        text: "Before\n\n\n!inkbook[[drawings/ink.svg]]\n\nAfter",
      },
      sectionFrom: 9,
      sectionTo: 37,
      sourcePath: "notes/note.md",
    });
    const bubbledActivation = vi.fn();
    section.addEventListener("click", bubbledActivation);
    activationButton?.dispatch("click");
    expect(ports.calls[ports.calls.length - 1]).toBe("activate:drawings/ink.svg");
    expect(bubbledActivation).not.toHaveBeenCalled();
    child?.unload();
    expect(ports.calls[ports.calls.length - 1]).toBe("detach:drawings/ink.svg");
    expect(section.classNames).not.toContain("inkbook-scrollbar-stable");
    expect(section.children).toEqual([root]);
    expect(root.isConnected).toBe(true);
    expect(root.children).toEqual([markerText, fileLink]);
    fileLink.dispatch("click");
    expect(ports.calls.filter((call) => call.startsWith("activate"))).toHaveLength(1);
  });
});

function expectReadingSectionUnchanged(root: FakeElement, text: string): void {
  const ports = createPorts();
  const originalChildren = [...root.children];
  const addChild = vi.fn();
  void createReadingViewPostProcessor(ports)(
    root as unknown as HTMLElement,
    {
      sourcePath: "notes/note.md",
      getSectionInfo: () => ({ lineStart: 0, lineEnd: 0, text }),
      addChild,
    } as never,
  );
  expect(addChild).not.toHaveBeenCalled();
  expect(root.children).toEqual(originalChildren);
  expect(ports.calls).toEqual([]);
}

describe("Reading-view target correlation", () => {
  it.each([
    { lineStart: -1, lineEnd: 0, text: "!inkbook[[drawings/ink.svg]]" },
    { lineStart: 0, lineEnd: -1, text: "!inkbook[[drawings/ink.svg]]" },
    { lineStart: 1, lineEnd: 1, text: "!inkbook[[drawings/ink.svg]]" },
    { lineStart: 0, lineEnd: 1, text: "!inkbook[[drawings/ink.svg]]" },
    { lineStart: 1, lineEnd: 1, text: "```md\n!inkbook[[drawings/ink.svg]]\n```" },
    { lineStart: 1, lineEnd: 1, text: "<!--\n!inkbook[[drawings/ink.svg]]\n-->" },
    { lineStart: 0, lineEnd: 1, text: "Before\n!inkbook[[drawings/ink.svg]]" },
  ])("rejects invalid section bounds or suppressed surrounding syntax: $text", (section) => {
    const ports = createPorts();
    const addChild = vi.fn();
    void createReadingViewPostProcessor(ports)(
      new FakeElement() as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => section,
        addChild,
      } as never,
    );
    expect(addChild).not.toHaveBeenCalled();
    expect(ports.calls).toEqual([]);
  });

  it("fails closed when a Reading-view section contains other Markdown", () => {
    const root = new FakeElement();
    const unrelated = new FakeElement(root.ownerDocument, "img");
    unrelated.src = "app://vault/unrelated.png";
    const image = new FakeElement(root.ownerDocument, "img");
    image.src = "app://vault/stale.svg";
    image.currentSrc = "app://vault/drawings/../ink.svg";
    root.append(unrelated);
    root.append(image);
    expectReadingSectionUnchanged(root, "![other](unrelated.png) !inkbook[[drawings/ink.svg]]");
  });

  it("requires a standalone recognized raw embed", () => {
    const root = new FakeElement();
    const image = new FakeElement(root.ownerDocument, "img");
    image.src = "app://vault/ink.svg";
    root.append(image);
    expectReadingSectionUnchanged(root, "Before !inkbook[[drawings/ink.svg]] after");
  });

  it("fails closed inside code", () => {
    const ports = createPorts();
    const processor = createReadingViewPostProcessor(ports);
    const addChild = vi.fn();
    const code = new FakeElement(undefined, "code");
    const codeImage = new FakeElement(code.ownerDocument, "img");
    codeImage.src = "app://vault/ink.svg";
    code.append(codeImage);
    void processor(
      code as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({ lineEnd: 0, lineStart: 0, text: "!inkbook[[drawings/ink.svg]]" }),
        addChild,
      } as never,
    );

    expect(addChild).not.toHaveBeenCalled();
  });
});

describe("Live Preview embed integration", () => {
  it("ignores cursor-only transactions but refreshes content, viewport, and mode changes", () => {
    const context = { enabled: true, sourcePath: "notes/note.md" };
    expect(
      shouldRefreshLivePreview({ docChanged: false, viewportChanged: false }, context, context),
    ).toBe(false);
    expect(
      shouldRefreshLivePreview({ docChanged: true, viewportChanged: false }, context, context),
    ).toBe(true);
    expect(
      shouldRefreshLivePreview({ docChanged: false, viewportChanged: false }, context, {
        ...context,
        enabled: false,
      }),
    ).toBe(true);
  });
});

describe("Live Preview widget lifecycle", () => {
  it("creates and destroys a Live Preview widget in its owning document", () => {
    const ports = createPorts();
    const created: FakeElement[] = [];
    const ownerDocument = new FakeElement().ownerDocument;
    const widget = new InkbookLivePreviewWidget(livePreviewEmbed(), ports);
    const root = widget.toDOM({
      dom: {
        ownerDocument,
        createDiv: () => {
          const element = new FakeElement(ownerDocument);
          created.push(element);
          return element;
        },
      },
    } as never) as unknown as FakeElement;

    expect(created).toHaveLength(1);
    expect(root.tagName).toBe("DIV");
    const activationButton = requireOwnedPreview(root, root.children[0]);
    expect(activationButton?.children[0]?.style["--inkbook-preview-aspect-ratio"]).toBe("12");
    expect(activationButton?.children[0]?.children[0]?.classNames).toContain(
      "inkbook-locked-preview-svg",
    );
    activationButton?.dispatch("click");
    expect(ports.calls).toEqual(["mount:drawings/ink.svg", "activate:drawings/ink.svg"]);
    expect(ports.attachments[0]?.embedReference).toEqual({
      documentId: "drawings/ink.svg",
      from: 4,
      kind: "live-preview",
      sourcePath: "notes/note.md",
      to: 28,
    });
    expect(ports.attachments[0]?.preview).toBe(activationButton);
    expect(ports.attachments[0]?.previewContentIdentity).toEqual(CONTENT_IDENTITY);
    ports.attachments[0]?.setPreviewAspectRatio?.(4);
    expect(activationButton.children[0]?.style["--inkbook-preview-aspect-ratio"]).toBe("4");
    widget.destroy(root as unknown as HTMLElement);
    expect(ports.calls[ports.calls.length - 1]).toBe("detach:drawings/ink.svg");
  });
});
