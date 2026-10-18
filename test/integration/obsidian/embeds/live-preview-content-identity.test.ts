import { describe, expect, it, vi } from "vitest";

import { InkbookLivePreviewWidget } from "../../../../src/obsidian/embeds/live-preview-widget";
import * as previewBuilder from "../../../../src/obsidian/embeds/safe-preview-builder";
import { PresentationLifecycleRegistry } from "../../../../src/obsidian/embeds/presentation-lifecycle-registry";
import type {
  EmbedIntegrationPorts,
  PresentationAttachment,
} from "../../../../src/obsidian/embeds/presentation-port";
import { ColorSchemeBroadcaster } from "../../../../src/obsidian/theme/color-scheme";
import { FakePresentationElement } from "../../../fixtures/obsidian/presentation-dom";
import { nativeFrameWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import { createDetachedPreviewHandoff } from "../../../fixtures/obsidian/active-preview-handoff";

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

  it("rejects updates for a different attachment or a disposed presentation", () => {
    const ports = createPorts();
    const mounted = new InkbookLivePreviewWidget(embed(), ports);
    const root = mounted.toDOM({
      plugin: () => null,
      dom: { createDiv: () => new FakePresentationElement() },
    } as never);
    const changed = new InkbookLivePreviewWidget({ ...embed(), from: 5 }, ports);
    expect(changed.updateDOM(root)).toBe(false);
    expect(new InkbookLivePreviewWidget(embed(), createPorts()).updateDOM(root)).toBe(false);
    expect(ports.calls).toEqual([]);
    mounted.destroy(root);
    expect(mounted.updateDOM(root)).toBe(false);
    expect(ports.calls).toEqual(["detach:drawings/ink.svg"]);
  });

  it("disposes the mounted controller when an equal widget receives destroy", () => {
    const ports = createPorts();
    const mounted = new InkbookLivePreviewWidget(embed(), ports);
    const reconciled = new InkbookLivePreviewWidget(embed(), ports);
    const ownerDocument = new FakePresentationElement().ownerDocument;
    const root = mounted.toDOM({
      plugin: () => null,
      dom: {
        ownerDocument,
        createDiv: () => new FakePresentationElement(ownerDocument),
      },
    } as never);

    expect(mounted.eq(reconciled)).toBe(true);
    reconciled.destroy(root);
    expect(ports.calls[ports.calls.length - 1]).toBe("detach:drawings/ink.svg");
  });

  it("retargets a removed active preview through updateDOM without preparing its SVG", async () => {
    const ports = createPorts();
    const widget = new InkbookLivePreviewWidget(embed(), ports);
    const host = new FakePresentationElement();
    const root = widget.toDOM({ plugin: () => null, dom: host } as never);
    host.append(root as unknown as FakePresentationElement);
    const attachment = ports.attachments[0]!;
    const { handoff, preview } = await createDetachedPreviewHandoff(
      attachment,
      ports.workScheduler(root.ownerDocument.defaultView),
    );
    const builder = vi.spyOn(previewBuilder, "createPreviewSvgAsync");
    try {
      const latest = embed({ outputHash: "b".repeat(64), revision: 2 });
      expect(new InkbookLivePreviewWidget(latest, ports).updateDOM(root)).toBe(true);
      expect(attachment.previewContentIdentity).toEqual(latest.preview.contentIdentity);
      expect(builder).not.toHaveBeenCalled();
      await handoff.ensurePreviewReady();
      expect(builder).toHaveBeenCalledOnce();
      handoff.restorePreview();
      expect(preview.hidden).toBe(false);
      expect(preview.parentElement).toBe(root);
    } finally {
      builder.mockRestore();
      handoff.dispose();
      widget.destroy(root);
    }
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

function createPorts(): EmbedIntegrationPorts & {
  readonly attachments: PresentationAttachment[];
  readonly calls: string[];
} {
  const calls: string[] = [];
  const attachments: PresentationAttachment[] = [];
  return {
    attachments,
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
      mount: (attachment) => attachments.push(attachment),
    },
    workScheduler: nativeFrameWorkScheduler,
  };
}
