// @vitest-environment happy-dom

import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { MarkdownView, type App, type WorkspaceLeaf } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import { ObsidianEditorNoteIdentityResolverV1 } from "../../../src/adapters/obsidian/editor-note-identity";

const VAULT_ID = "0123456789abcdef0123456789abcdef";

describe("Obsidian editor note identity resolver", () => {
  it("matches the exact concrete editor to its MarkdownView file", () => {
    const firstEditorView = createEditorView();
    const secondEditorView = createEditorView();
    const leaves = [
      markdownLeaf("Notes/first.md", firstEditorView),
      markdownLeaf("Notes/second.md", secondEditorView),
    ];
    const resolver = new ObsidianEditorNoteIdentityResolverV1(
      appWithLeaves(leaves),
      VAULT_ID,
    );

    expect(resolver.resolve(secondEditorView)).toEqual({
      vaultIdHint: VAULT_ID,
      vaultRelativeMarkdownPath: "Notes/second.md",
    });

    firstEditorView.destroy();
    secondEditorView.destroy();
  });

  it("fails closed for unknown, deferred, and unsafe Markdown identities", () => {
    const known = createEditorView();
    const unknown = createEditorView();
    const deferred = markdownLeaf("Notes/deferred.md", known);
    Object.defineProperty(deferred, "isDeferred", { value: true });
    const resolver = new ObsidianEditorNoteIdentityResolverV1(
      appWithLeaves([deferred, markdownLeaf("../unsafe.md", known)]),
      VAULT_ID,
    );

    expect(resolver.resolve(known)).toBeNull();
    expect(resolver.resolve(unknown)).toBeNull();

    known.destroy();
    unknown.destroy();
  });
});

function createEditorView(): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: "Markdown" }),
  });
}

function markdownLeaf(path: string, editorView: EditorView): WorkspaceLeaf {
  const view = new MarkdownView({} as WorkspaceLeaf);
  Object.defineProperties(view, {
    editor: { value: { cm: editorView } },
    file: { value: { path } },
  });
  return { isDeferred: false, view } as unknown as WorkspaceLeaf;
}

function appWithLeaves(leaves: readonly WorkspaceLeaf[]): App {
  return {
    workspace: {
      iterateAllLeaves: vi.fn((callback: (leaf: WorkspaceLeaf) => void): void =>
        leaves.forEach(callback),
      ),
    },
  } as unknown as App;
}
