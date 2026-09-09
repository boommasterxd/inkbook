import { describe, expect, it } from "vitest";

import { InkbookLivePreviewWidget } from "../../../../src/obsidian/embeds/live-preview-widget";
import { PresentationLifecycleRegistry } from "../../../../src/obsidian/embeds/presentation-lifecycle-registry";
import type { EmbedIntegrationPorts } from "../../../../src/obsidian/embeds/presentation-port";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";

const SAFE_PREVIEW_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>';
const CONTENT_IDENTITY = { outputHash: "a".repeat(64), revision: 1 };

describe("Live Preview widget content identity", () => {
  it("includes the validated content identity in widget equality", () => {
    const ports = createPorts();
    const widget = new InkbookLivePreviewWidget(embed(), ports);

    expect(widget.eq(new InkbookLivePreviewWidget(embed(), ports))).toBe(true);
    expect(
      widget.eq(
        new InkbookLivePreviewWidget(embed({ outputHash: "b".repeat(64), revision: 2 }), ports),
      ),
    ).toBe(false);
  });

  it("retains path, range, and resource URL equality checks", () => {
    const ports = createPorts();
    const widget = new InkbookLivePreviewWidget(embed(), ports);

    expect(
      widget.eq(
        new InkbookLivePreviewWidget(
          { ...embed(), resolved: { documentId: "drawings/ink.svg", resourceUrl: "changed" } },
          ports,
        ),
      ),
    ).toBe(false);
    expect(widget.eq(new InkbookLivePreviewWidget({ ...embed(), from: 5 }, ports))).toBe(false);
  });

  it("disposes the mounted controller when an equal widget receives destroy", () => {
    const ports = createPorts();
    const mounted = new InkbookLivePreviewWidget(embed(), ports);
    const reconciled = new InkbookLivePreviewWidget(embed(), ports);
    const ownerDocument = new FakePresentationElement().ownerDocument;
    const root = mounted.toDOM({
      dom: {
        ownerDocument,
        createDiv: () => new FakePresentationElement(ownerDocument),
      },
    } as never);

    expect(mounted.eq(reconciled)).toBe(true);
    reconciled.destroy(root);
    expect(ports.calls[ports.calls.length - 1]).toBe("detach:drawings/ink.svg");
  });
});

function embed(contentIdentity = CONTENT_IDENTITY) {
  return {
    from: 4,
    preview: { aspectRatio: 12, contentIdentity, safeSvg: SAFE_PREVIEW_SVG },
    resolved: { documentId: "drawings/ink.svg", resourceUrl: "app://vault/ink.svg" },
    sourcePath: "notes/note.md",
    to: 28,
  };
}

function createPorts(): EmbedIntegrationPorts & { readonly calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    documents: {
      cached: () => false,
      recognize: async () => false,
      subscribe: () => () => undefined,
    },
    lifecycle: new PresentationLifecycleRegistry(),
    resolveDocument: () => undefined,
    scheme: new ColorSchemeBroadcaster({ getColorScheme: () => "light" }),
    sessions: {
      activate: () => undefined,
      detach: (attachment) => calls.push(`detach:${attachment.documentId}`),
      mount: () => undefined,
    },
  };
}
