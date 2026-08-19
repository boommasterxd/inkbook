// @vitest-environment happy-dom

import { MarkdownView, type Workspace, type WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { ObsidianWorkspaceBoundary } from "../../../../src/adapters/obsidian/views";

const MARKDOWN_SURFACE_COUNT = 3;
const LIMITED_LEAF_COUNT = 2;

function markdownLeaf(
  mode: "preview" | "source",
  source: boolean,
): WorkspaceLeaf {
  const element = document.createElement("div");
  const unsubscribe = vi.fn();
  Object.defineProperties(element, {
    doc: { get: (): Document => document },
    onWindowMigrated: { value: vi.fn(() => unsubscribe) },
    win: { get: (): Window => window },
  });
  const view = new MarkdownView({} as WorkspaceLeaf) as MarkdownView & {
    getMode(): "preview" | "source";
    getState(): Record<string, unknown>;
    getViewType(): string;
    containerEl: HTMLElement;
  };
  view.containerEl = element;
  Object.defineProperty(view, "file", { value: { path: "note.md" } });
  view.getMode = (): "preview" | "source" => mode;
  view.getState = (): Record<string, unknown> => ({ source });
  view.getViewType = (): string => "markdown";
  return { isDeferred: false, view } as unknown as WorkspaceLeaf;
}

function unsupportedLeaf(type: string): WorkspaceLeaf {
  return {
    isDeferred: false,
    view: { getViewType: (): string => type },
  } as unknown as WorkspaceLeaf;
}

describe("ObsidianWorkspaceBoundary", () => {
  it("classifies native surfaces and excludes deferred and unsupported leaves", () => {
    const live = markdownLeaf("source", false);
    const source = markdownLeaf("source", true);
    const reading = markdownLeaf("preview", false);
    const leaves = [
      live,
      source,
      reading,
      unsupportedLeaf("bases"),
      unsupportedLeaf("pdf"),
    ];
    let layoutCallback: (() => void) | undefined;
    const workspace = {
      iterateAllLeaves: (callback: (leaf: WorkspaceLeaf) => void): void => {
        leaves.forEach(callback);
      },
      onLayoutReady: (callback: () => void): void => {
        layoutCallback = callback;
      },
    } as unknown as Workspace;
    const boundary = new ObsidianWorkspaceBoundary(workspace);

    const collected = boundary.collectLeaves(leaves.length);
    expect(collected.map((leaf) => leaf.readView().kind)).toEqual([
      "markdown",
      "markdown",
      "markdown",
      "bases",
      "non-markdown",
    ]);
    expect(
      collected.slice(0, MARKDOWN_SURFACE_COUNT).map((leaf) => leaf.readView()),
    ).toMatchObject([
      { surface: "live-preview" },
      { surface: "source" },
      { surface: "reading" },
    ]);

    const markdown = collected[0]?.readView();
    if (markdown?.kind !== "markdown") throw new Error("Expected Markdown");
    expect(markdown.element.doc).toBe(document);
    expect(markdown.element.win).toBe(window);
    expect(markdown.element.instanceOf(document.body, window.HTMLElement)).toBe(
      true,
    );
    const migration = vi.fn();
    markdown.element.onWindowMigrated(migration).dispose();

    boundary.onLayoutReady(vi.fn());
    expect(layoutCallback).toBeTypeOf("function");
    expect(boundary.collectLeaves(LIMITED_LEAF_COUNT)).toHaveLength(
      LIMITED_LEAF_COUNT,
    );
    expect(boundary.collectLeaves(LIMITED_LEAF_COUNT)[0]).toBe(collected[0]);
  });

  it("exposes deferred state without loading the leaf", () => {
    const loadIfDeferred = vi.fn();
    const leaf = {
      isDeferred: true,
      loadIfDeferred,
      view: { getViewType: (): string => "markdown" },
    } as unknown as WorkspaceLeaf;
    const boundary = new ObsidianWorkspaceBoundary({
      iterateAllLeaves: (callback: (value: WorkspaceLeaf) => void): void =>
        callback(leaf),
      onLayoutReady: vi.fn(),
    } as unknown as Workspace);

    expect(boundary.collectLeaves(1)[0]?.isDeferred).toBe(true);
    expect(loadIfDeferred).not.toHaveBeenCalled();
  });
});
