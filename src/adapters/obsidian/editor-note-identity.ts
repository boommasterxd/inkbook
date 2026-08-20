import type { EditorView } from "@codemirror/view";
import {
  MarkdownView,
  normalizePath,
  type App,
  type WorkspaceLeaf,
} from "obsidian";

import {
  freezeNoteIdentity,
  type NoteIdentityV1,
  type ViewId,
} from "../../application/note-session";
import { normalizeVaultRelativePathV1 } from "../../application/vault-path";
import { accessEditorViewV1 } from "./editor-history/editor-view-access";
import type { EditorNoteIdentityResolverV1 } from "./plugin-runtime";

const MAX_DISCOVERED_LEAVES = 256;
export const MAX_ACTIVE_EDITOR_IDENTITIES = 256;

export class EditorIdentityPool {
  readonly #activeIds = new Set<ViewId>();
  #disposed = false;

  public claim(): ViewId | null {
    if (this.#disposed) return null;
    for (let slot = 1; slot <= MAX_ACTIVE_EDITOR_IDENTITIES; slot += 1) {
      const editorViewId = `inkbook-editor-${String(slot)}` as ViewId;
      if (this.#activeIds.has(editorViewId)) continue;
      this.#activeIds.add(editorViewId);
      return editorViewId;
    }
    return null;
  }

  public release(editorViewId: ViewId): void {
    this.#activeIds.delete(editorViewId);
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#activeIds.clear();
  }
}

export function resolveRuntimeEditorIdentityV1(
  resolver:
    | { readonly resolve: (view: EditorView) => NoteIdentityV1 | null }
    | undefined,
  view: EditorView,
): NoteIdentityV1 | null {
  try {
    const resolved = resolver?.resolve(view) ?? null;
    return resolved === null ? null : freezeNoteIdentity(resolved);
  } catch {
    return null;
  }
}

/** Resolves only an exact concrete MarkdownView/editor pair already owned by Obsidian. */
export class ObsidianEditorNoteIdentityResolverV1 implements EditorNoteIdentityResolverV1 {
  public constructor(
    private readonly app: App,
    private readonly vaultId: string,
  ) {}

  public resolve(editorView: EditorView): NoteIdentityV1 | null {
    let resolved: NoteIdentityV1 | null = null;
    let inspected = 0;
    this.app.workspace.iterateAllLeaves((leaf) => {
      if (
        resolved !== null ||
        inspected >= MAX_DISCOVERED_LEAVES ||
        leaf.isDeferred
      ) {
        return;
      }
      inspected += 1;
      resolved = this.#resolveLeaf(leaf, editorView);
    });
    return resolved;
  }

  #resolveLeaf(
    leaf: WorkspaceLeaf,
    editorView: EditorView,
  ): NoteIdentityV1 | null {
    const view = leaf.view;
    if (!(view instanceof MarkdownView)) return null;
    const filePath = view.file?.path;
    if (filePath === undefined) return null;
    const candidate = accessEditorViewV1(view.editor);
    if (candidate.kind !== "available" || candidate.view !== editorView) {
      return null;
    }
    try {
      return Object.freeze({
        vaultIdHint: this.vaultId,
        vaultRelativeMarkdownPath: normalizeVaultRelativePathV1(filePath, {
          name: "Markdown path",
          normalizePath,
          requiredSuffix: ".md",
        }),
      });
    } catch {
      return null;
    }
  }
}
