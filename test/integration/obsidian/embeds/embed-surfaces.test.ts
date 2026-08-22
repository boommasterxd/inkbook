import { describe, expect, it, vi } from "vitest";

import {
  createReadingViewPostProcessor,
  findEmbedsInVisibleRanges,
  findMarkdownInkbookEmbeds,
  InkbookLivePreviewWidget,
  MARKDOWN_EMBED_LIMITS,
  PresentationLifecycleRegistry,
  shouldRefreshLivePreview,
  type EmbedIntegrationPorts,
} from "../../../../src/obsidian/embeds";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { executableSyntaxIn } from "../../../fixtures/obsidian/live-preview";
import { FakePresentationElement as FakeElement } from "../../../fixtures/obsidian/presentation-dom";

function createPorts(): EmbedIntegrationPorts & {
  readonly attachments: Array<{ readonly embedReference: unknown }>;
  readonly calls: string[];
  readonly setDark: () => void;
} {
  let dark = false;
  const calls: string[] = [];
  const attachments: Array<{ readonly embedReference: unknown }> = [];
  return {
    attachments,
    calls,
    documents: {
      cached: () => ({ aspectRatio: 12 }),
      recognize: async () => ({ aspectRatio: 12 }),
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
  it("parses supported SVG embeds without treating other attachments as ink", () => {
    expect(
      findMarkdownInkbookEmbeds("![[drawings/ink.svg|600]] and ![preview](other.svg) ![[note.md]]"),
    ).toMatchObject([
      { linkpath: "drawings/ink.svg", markdown: "![[drawings/ink.svg|600]]" },
      { linkpath: "other.svg", markdown: "![preview](other.svg)" },
    ]);
  });

  it("ignores embed-like text in code, comments, and escaped Markdown", () => {
    const markdown = [
      "`![[drawings/ink.svg]]`",
      "```md",
      "![[drawings/ink.svg]]",
      "```",
      "<!-- ![preview](drawings/ink.svg) -->",
      String.raw`\![[drawings/ink.svg]]`,
      "![[drawings/ink.svg]]",
      "![preview](drawings/ink.svg)",
    ].join("\n");

    expect(findMarkdownInkbookEmbeds(markdown).map((embed) => embed.markdown)).toEqual([
      "![[drawings/ink.svg]]",
      "![preview](drawings/ink.svg)",
    ]);
  });

  it("fails closed before matching an oversized UTF-8 Markdown section", () => {
    const oversized = `${"x".repeat(MARKDOWN_EMBED_LIMITS.inputBytes)}é`;

    expect(findMarkdownInkbookEmbeds(oversized)).toEqual([]);
  });

  it("fails closed before accumulating too many Markdown matches", () => {
    const tooManyEmbeds = Array.from(
      { length: MARKDOWN_EMBED_LIMITS.matches + 1 },
      () => "![[drawings/ink.svg]]",
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
        getSectionInfo: () => ({ text: "![[drawings/ink.svg]] ![[drawings/ink.svg]]" }),
        addChild,
      } as never,
    );
    expect(addChild).not.toHaveBeenCalled();
    expect(ports.calls).toEqual([]);
  });

  it("owns Reading-view activation and cleanup through a render child", () => {
    const ports = createPorts();
    const root = new FakeElement();
    const nativeWrapper = new FakeElement(root.ownerDocument);
    const image = new FakeElement(root.ownerDocument, "img");
    image.src = "app://vault/ink.svg";
    const nativeControls = new FakeElement(root.ownerDocument);
    nativeWrapper.append(image);
    root.append(nativeWrapper);
    root.append(nativeControls);
    const processor = createReadingViewPostProcessor(ports);
    let child: { load(): void; unload(): void } | undefined;

    void processor(
      root as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({
          lineEnd: 12,
          lineStart: 12,
          text: "![[drawings/ink.svg]]",
        }),
        addChild: (nextChild: { load(): void; unload(): void }) => {
          child = nextChild;
          nextChild.load();
        },
      } as never,
    );

    expect(ports.calls).toEqual(["mount:drawings/ink.svg"]);
    expect(root.children[0]?.classNames).toContain("inkbook-root");
    expect(root.classNames).toContain("inkbook-scrollbar-stable");
    expect(root.children[0]?.style.colorScheme).toBe("light");
    const activationButton = requireOwnedPreview(root, root.children[0]?.children[0]);
    expect(root.children).toHaveLength(1);
    expect(ports.attachments[0]?.embedReference).toEqual({
      documentId: "drawings/ink.svg",
      kind: "reading-view",
      markdown: "![[drawings/ink.svg]]",
      section: {
        lineEnd: 12,
        lineStart: 12,
        text: "![[drawings/ink.svg]]",
      },
      sectionFrom: 0,
      sectionTo: 21,
      sourcePath: "notes/note.md",
    });
    const bubbledActivation = vi.fn();
    root.addEventListener("click", bubbledActivation);
    activationButton?.dispatch("click");
    expect(ports.calls[ports.calls.length - 1]).toBe("activate:drawings/ink.svg");
    expect(bubbledActivation).not.toHaveBeenCalled();
    child?.unload();
    expect(ports.calls[ports.calls.length - 1]).toBe("detach:drawings/ink.svg");
    expect(root.classNames).not.toContain("inkbook-scrollbar-stable");
    expect(root.children).toEqual([nativeWrapper, nativeControls]);
    image.dispatch("click");
    expect(ports.calls.filter((call) => call.startsWith("activate"))).toHaveLength(1);
  });
});

describe("Reading-view target correlation", () => {
  it("fails closed when a Reading-view section contains another native image", () => {
    const ports = createPorts();
    const root = new FakeElement();
    const unrelated = new FakeElement(root.ownerDocument, "img");
    unrelated.src = "app://vault/unrelated.png";
    const image = new FakeElement(root.ownerDocument, "img");
    image.src = "app://vault/stale.svg";
    image.currentSrc = "app://vault/drawings/../ink.svg";
    root.append(unrelated);
    root.append(image);
    const addChild = vi.fn();

    void createReadingViewPostProcessor(ports)(
      root as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({ text: "![other](unrelated.png) ![[drawings/ink.svg]]" }),
        addChild,
      } as never,
    );

    expect(addChild).not.toHaveBeenCalled();
  });

  it("requires a standalone recognized raw embed before correlating the rendered image", () => {
    const ports = createPorts();
    const root = new FakeElement();
    const image = new FakeElement(root.ownerDocument, "img");
    image.src = "app://vault/ink.svg";
    root.append(image);
    const addChild = vi.fn();

    void createReadingViewPostProcessor(ports)(
      root as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({
          text: "Before ![[drawings/ink.svg]] after",
        }),
        addChild,
      } as never,
    );

    expect(addChild).not.toHaveBeenCalled();
  });

  it("fails closed for mismatched, ambiguous, and code-contained Reading-view images", () => {
    const ports = createPorts();
    const processor = createReadingViewPostProcessor(ports);
    const addChild = vi.fn();
    const mismatchedRoot = new FakeElement();
    const mismatchedImage = new FakeElement(mismatchedRoot.ownerDocument, "img");
    mismatchedImage.src = "app://vault/other.svg";
    mismatchedRoot.append(mismatchedImage);
    void processor(
      mismatchedRoot as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({ text: "![[drawings/ink.svg]]" }),
        addChild,
      } as never,
    );

    const ambiguousRoot = new FakeElement();
    for (let index = 0; index < 2; index += 1) {
      const image = new FakeElement(ambiguousRoot.ownerDocument, "img");
      image.src = "app://vault/ink.svg";
      ambiguousRoot.append(image);
    }
    void processor(
      ambiguousRoot as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({ text: "![[drawings/ink.svg]]" }),
        addChild,
      } as never,
    );

    const code = new FakeElement(undefined, "code");
    const codeImage = new FakeElement(code.ownerDocument, "img");
    codeImage.src = "app://vault/ink.svg";
    code.append(codeImage);
    void processor(
      code as unknown as HTMLElement,
      {
        sourcePath: "notes/note.md",
        getSectionInfo: () => ({ text: "![[drawings/ink.svg]]" }),
        addChild,
      } as never,
    );

    expect(addChild).not.toHaveBeenCalled();
  });
});

describe("Live Preview embed integration", () => {
  it("creates candidates only inside visible ranges", () => {
    const text = "![[drawings/hidden.svg]]\ntext\n![[drawings/ink.svg]]";
    const visibleFrom = text.indexOf("![[drawings/ink.svg]]");
    const readText = vi.fn((from: number, to: number) => text.slice(from, to));
    const resolved = findEmbedsInVisibleRanges(
      readText,
      [{ from: visibleFrom, to: text.length }],
      "notes/note.md",
      createPorts().resolveDocument,
      executableSyntaxIn(text),
    );

    expect(resolved).toEqual([
      {
        from: visibleFrom,
        sourcePath: "notes/note.md",
        to: text.length,
        resolved: { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" },
      },
    ]);
    expect(readText).toHaveBeenCalledOnce();
    expect(readText).toHaveBeenCalledWith(visibleFrom, text.length);
  });

  it("fails closed when visible embed syntax is missing or unknown", () => {
    const text = "![[drawings/ink.svg]]";
    const resolveDocument = createPorts().resolveDocument;

    expect(
      findEmbedsInVisibleRanges(
        (from, to) => text.slice(from, to),
        [{ from: 0, to: text.length }],
        "notes/note.md",
        resolveDocument,
        () => true,
      ),
    ).toEqual([]);
  });

  it("accepts executable Wiki and Markdown image syntax", () => {
    const text = "![[drawings/ink.svg]]\n![Handwriting](drawings/ink.svg)";
    const embeds = findEmbedsInVisibleRanges(
      (from, to) => text.slice(from, to),
      [{ from: 0, to: text.length }],
      "notes/note.md",
      createPorts().resolveDocument,
      executableSyntaxIn(text),
    );

    expect(embeds.map(({ from, to }) => text.slice(from, to))).toEqual([
      "![[drawings/ink.svg]]",
      "![Handwriting](drawings/ink.svg)",
    ]);
  });

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
    const widget = new InkbookLivePreviewWidget(
      {
        from: 4,
        preview: { aspectRatio: 12 },
        resolved: { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" },
        sourcePath: "notes/note.md",
        to: 28,
      },
      ports,
    );
    const root = widget.toDOM({
      dom: {
        ownerDocument,
        createSpan: () => {
          const element = new FakeElement(ownerDocument);
          created.push(element);
          return element;
        },
      },
    } as never) as unknown as FakeElement;

    expect(created).toHaveLength(1);
    const activationButton = requireOwnedPreview(root, root.children[0]);
    expect(activationButton?.children[0]?.style.backgroundImage).toBe('url("app://vault/ink.svg")');
    activationButton?.dispatch("click");
    expect(ports.calls).toEqual(["mount:drawings/ink.svg", "activate:drawings/ink.svg"]);
    expect(ports.attachments[0]?.embedReference).toEqual({
      documentId: "drawings/ink.svg",
      from: 4,
      kind: "live-preview",
      sourcePath: "notes/note.md",
      to: 28,
    });
    widget.destroy(root as unknown as HTMLElement);
    expect(ports.calls[ports.calls.length - 1]).toBe("detach:drawings/ink.svg");
  });
});

describe("Live Preview widget reconciliation", () => {
  it("includes both the document path and resource URL in widget identity", () => {
    const ports = createPorts();
    const widget = new InkbookLivePreviewWidget(
      {
        from: 4,
        preview: { aspectRatio: 12 },
        resolved: { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" },
        sourcePath: "notes/note.md",
        to: 28,
      },
      ports,
    );

    expect(
      widget.eq(
        new InkbookLivePreviewWidget(
          {
            from: 4,
            preview: { aspectRatio: 12 },
            resolved: { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" },
            sourcePath: "notes/note.md",
            to: 28,
          },
          ports,
        ),
      ),
    ).toBe(true);
    expect(
      widget.eq(
        new InkbookLivePreviewWidget(
          {
            from: 4,
            preview: { aspectRatio: 12 },
            resolved: {
              documentId: "drawings/ink.svg",
              resourceUrl: "app://vault/reissued.svg",
            },
            sourcePath: "notes/note.md",
            to: 28,
          },
          ports,
        ),
      ),
    ).toBe(false);
    expect(
      widget.eq(
        new InkbookLivePreviewWidget(
          {
            from: 5,
            preview: { aspectRatio: 12 },
            resolved: { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" },
            sourcePath: "notes/note.md",
            to: 28,
          },
          ports,
        ),
      ),
    ).toBe(false);
  });

  it("disposes the mounted controller when an equal CM6 widget receives destroy", () => {
    const ports = createPorts();
    const embed = {
      from: 4,
      preview: { aspectRatio: 12 },
      resolved: { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" },
      sourcePath: "notes/note.md",
      to: 28,
    };
    const mounted = new InkbookLivePreviewWidget(embed, ports);
    const reconciled = new InkbookLivePreviewWidget(embed, ports);
    const ownerDocument = new FakeElement().ownerDocument;
    const root = mounted.toDOM({
      dom: {
        ownerDocument,
        createSpan: () => new FakeElement(ownerDocument),
      },
    } as never);

    expect(mounted.eq(reconciled)).toBe(true);
    reconciled.destroy(root);
    expect(ports.calls[ports.calls.length - 1]).toBe("detach:drawings/ink.svg");
  });
});
