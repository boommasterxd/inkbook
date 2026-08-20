// @vitest-environment happy-dom

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App, PluginManifest } from "obsidian";
import { describe, expect, it } from "vitest";

import InkbookPlugin from "../../../src/main";
import {
  EditorIdentityPool,
  MAX_ACTIVE_EDITOR_IDENTITIES,
} from "../../../src/adapters/obsidian/plugin-runtime";

const BELOW_EDITOR_LIMIT = MAX_ACTIVE_EDITOR_IDENTITIES - 1;

describe("EditorIdentityPool", () => {
  it("admits below and at the limit, then fails closed above it", () => {
    const pool = new EditorIdentityPool();
    const belowLimit = Array.from({ length: BELOW_EDITOR_LIMIT }, () =>
      pool.claim(),
    );

    expect(belowLimit).not.toContain(null);
    expect(new Set(belowLimit)).toHaveLength(BELOW_EDITOR_LIMIT);
    expect(pool.claim()).not.toBeNull();
    expect(pool.claim()).toBeNull();
  });

  it("reuses a detached slot without colliding with an active identity", () => {
    const pool = new EditorIdentityPool();
    const active = Array.from({ length: MAX_ACTIVE_EDITOR_IDENTITIES }, () =>
      pool.claim(),
    );
    const released = active[0];
    if (released === null || released === undefined) {
      throw new Error("Expected an admitted editor identity.");
    }

    pool.release(released);
    pool.release(released);
    const replacement = pool.claim();

    expect(replacement).toBe(released);
    expect(active.slice(1)).not.toContain(replacement);
    expect(pool.claim()).toBeNull();
  });

  it("rejects claims after idempotent disposal", () => {
    const pool = new EditorIdentityPool();
    const identity = pool.claim();
    if (identity === null) throw new Error("Expected an editor identity.");

    pool.dispose();
    pool.dispose();
    pool.release(identity);

    expect(pool.claim()).toBeNull();
  });
});

describe("PluginRuntime editor lifecycle", () => {
  it("attaches without changing Markdown and releases after disposal", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      { id: "inkbook" } as PluginManifest,
    );
    await plugin.onload();
    const extensions = (
      plugin as unknown as { readonly editorExtensions: readonly unknown[] }
    ).editorExtensions as readonly Extension[];
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "Native Markdown",
        extensions,
      }),
    });

    expect(view.state.doc.toString()).toBe("Native Markdown");
    expect(plugin.onunload()).toBeUndefined();
    expect(plugin.onunload()).toBeUndefined();
    expect(() => view.destroy()).not.toThrow();
  });
});
