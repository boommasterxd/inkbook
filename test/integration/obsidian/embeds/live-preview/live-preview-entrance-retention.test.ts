import { InkbookLivePreviewWidget } from "../../../../../src/obsidian/embeds/live-preview/live-preview-widget";
import { EditorState } from "@codemirror/state";
import { EditorView, type DecorationSet } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { createLivePreviewExtension } from "../../../../../src/obsidian/embeds/live-preview/live-preview";
import type { EmbedIntegrationPorts } from "../../../../../src/obsidian/embeds/presentation/presentation-port";
import type { PresentationEntranceState } from "../../../../../src/obsidian/embeds/presentation/presentation-entrance";
import { configureTestEditorState } from "../../../../adapters/obsidian/plugin";
import { FakePresentationElement } from "../../../../fixtures/obsidian/presentation-dom";
import { nativeFrameWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";

const captures = vi.hoisted(() => ({
  previews: [] as { entranceState?: PresentationEntranceState }[],
}));
vi.mock("../../../../../src/obsidian/embeds/presentation/presentation-controller", () => ({
  PresentationController: class {
    constructor(
      _attachment: unknown,
      _sessions: unknown,
      _scheme: unknown,
      preview: { entranceState?: PresentationEntranceState },
    ) {
      captures.previews.push(preview);
    }
    mount() {
      /* Lifecycle behavior is covered by controller tests. */
    }
    dispose() {
      /* No resources are allocated by this capture adapter. */
    }
  },
}));

const EMBED = "!inkbook[[drawing.svg]]";

function createHarness(sourcePath = "note.md") {
  let revision = 1;
  const ports = {
    documents: {
      cached: () => ({
        aspectRatio: 4,
        contentIdentity: { outputHash: "a".repeat(64), revision },
        safeSvg: '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata></svg>',
      }),
    },
    lifecycle: { register: () => () => undefined },
    resolveDocument: () => ({ documentId: "drawing.svg", resourceUrl: "app://drawing.svg" }),
    workScheduler: nativeFrameWorkScheduler,
  } as unknown as EmbedIntegrationPorts;
  configureTestEditorState({ file: { path: sourcePath }, livePreview: true });
  const state = EditorState.create({
    doc: `${EMBED}\n\n${EMBED}`,
    extensions: [editorInfoField, editorLivePreviewField, createLivePreviewExtension(ports)],
  });
  return {
    state,
    changeDescriptor: () => {
      revision += 1;
    },
  };
}

function mountToken(state: EditorState, occurrence = 0): PresentationEntranceState {
  const widgets: InkbookLivePreviewWidget[] = [];
  const decorations = state.facet(EditorView.decorations)[0] as DecorationSet;
  decorations.between(0, state.doc.length, (_from, _to, decoration) => {
    const specification = decoration.spec as { readonly widget?: unknown };
    if (specification.widget instanceof InkbookLivePreviewWidget)
      widgets.push(specification.widget);
  });
  const root = new FakePresentationElement();
  widgets[occurrence]?.toDOM({ dom: { createDiv: () => root } } as never);
  const token = captures.previews[captures.previews.length - 1]?.entranceState;
  expect(token).toBeDefined();
  return token!;
}

describe("Live Preview entrance retention integration", () => {
  it("passes the same presented token through remounts, offset changes and descriptor rebuilds", () => {
    const harness = createHarness();
    const token = mountToken(harness.state);
    token.presented = true;
    expect(mountToken(harness.state)).toBe(token);
    const second = mountToken(harness.state, 1);
    expect(second).not.toBe(token);
    harness.changeDescriptor();
    const moved = harness.state.update({ changes: { from: 0, insert: "Heading\n\n" } }).state;
    expect(mountToken(moved)).toBe(token);
    expect(mountToken(moved, 1)).toBe(second);
    const appended = moved.update({
      changes: { from: moved.doc.length, insert: `\n\n${EMBED}` },
    }).state;
    expect(mountToken(appended)).toBe(token);
    expect(mountToken(appended, 2).presented).toBe(false);
  });

  it("starts fresh for another note and for a new editor lifetime of the same note", () => {
    const token = mountToken(createHarness().state);
    token.presented = true;
    expect(mountToken(createHarness("other.md").state)).not.toBe(token);
    expect(mountToken(createHarness().state).presented).toBe(false);
  });
});
