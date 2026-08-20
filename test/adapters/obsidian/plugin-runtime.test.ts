// @vitest-environment happy-dom

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { App, PluginManifest } from "obsidian";
import { describe, expect, it, vi } from "vitest";

import InkbookPlugin from "../../../src/main";
import {
  EditorIdentityPool,
  MAX_ACTIVE_EDITOR_IDENTITIES,
  PluginRuntime,
} from "../../../src/adapters/obsidian/plugin-runtime";
import { createSidecarStoragePolicyStore } from "../../../src/application/persistence";
import type { SidecarStoragePolicyStoreV1 } from "../../../src/application/persistence";
import {
  parseViewId,
  type NoteIdentityV1,
} from "../../../src/application/note-session";
import type { RecoveryStore } from "../../../src/application/recovery";

const BELOW_EDITOR_LIMIT = MAX_ACTIVE_EDITOR_IDENTITIES - 1;
const SHARED_NOTE: NoteIdentityV1 = Object.freeze({
  vaultIdHint: "vault-identity",
  vaultRelativeMarkdownPath: "Notes/shared.md",
});

async function storagePolicy(): Promise<SidecarStoragePolicyStoreV1> {
  return createSidecarStoragePolicyStore({
    loadData: async () => null,
    saveData: async () => undefined,
  });
}

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
  it("loads and validates settings before registering runtime consumers", async () => {
    let acknowledgeLoad: ((value: unknown) => void) | undefined;
    const onLayoutReady = vi.fn();
    const plugin = new InkbookPlugin(
      { workspace: { onLayoutReady } } as unknown as App,
      { id: "inkbook" } as PluginManifest,
    );
    plugin.loadData = (): Promise<unknown> =>
      new Promise((resolve) => {
        acknowledgeLoad = resolve;
      });

    const loading = plugin.onload();
    expect(runtimeExtensions(plugin)).toHaveLength(0);

    acknowledgeLoad?.({ version: 1, mode: "adjacent" });
    await loading;
    expect(runtimeExtensions(plugin)).toHaveLength(0);
    expect(onLayoutReady).toHaveBeenCalledOnce();
    plugin.onunload();
  });

  it("attaches without changing Markdown and releases after disposal", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      { id: "inkbook" } as PluginManifest,
    );
    const runtime = new PluginRuntime(plugin, {
      recoveryStore: null,
      storagePolicy: await storagePolicy(),
    });
    runtime.register();
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
    await runtime.dispose();
    await runtime.dispose();
    expect(() => view.destroy()).not.toThrow();
  });

  it("shares one bounded session across two resolved editor panes", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      { id: "inkbook" } as PluginManifest,
    );
    const runtime = new PluginRuntime(plugin, {
      noteIdentityResolver: {
        resolve: (): NoteIdentityV1 => SHARED_NOTE,
      },
      recoveryStore: null,
      storagePolicy: await storagePolicy(),
    });
    runtime.register();
    const extensions = runtimeExtensions(plugin);
    const first = createEditor("First pane", extensions);
    const second = createEditor("Second pane", extensions);

    expect(runtime.sessionCount).toBe(1);
    expect(runtime.referenceCount(SHARED_NOTE)).toBe(Number("2"));
    expect(first.state.doc.toString()).toBe("First pane");
    expect(second.state.doc.toString()).toBe("Second pane");
    expect(runtime.statusFor(parseViewId("inkbook-editor-1"))).toBeNull();
    expect(runtime.statusFor(parseViewId("inkbook-editor-99"))).toBeNull();
    expect(runtime.removalFor(parseViewId("inkbook-editor-1"))).toBeNull();

    first.destroy();
    expect(runtime.referenceCount(SHARED_NOTE)).toBe(1);
    second.destroy();
    expect(runtime.referenceCount(SHARED_NOTE)).toBe(0);
    await runtime.dispose();
  });
});

describe("PluginRuntime bounded resources", () => {
  it("releases editor attachments over fifty create and destroy cycles", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      { id: "inkbook" } as PluginManifest,
    );
    const runtime = new PluginRuntime(plugin, {
      noteIdentityResolver: {
        resolve: (): NoteIdentityV1 => SHARED_NOTE,
      },
      recoveryStore: null,
      storagePolicy: await storagePolicy(),
    });
    runtime.register();
    const extensions = runtimeExtensions(plugin);

    for (let cycle = 0; cycle < Number("50"); cycle += 1) {
      const view = createEditor(`Markdown ${String(cycle)}`, extensions);
      expect(runtime.referenceCount(SHARED_NOTE)).toBe(1);
      view.destroy();
      expect(runtime.referenceCount(SHARED_NOTE)).toBe(0);
    }

    await runtime.dispose();
    expect(runtime.sessionCount).toBe(0);
  });

  it("fails closed when the editor has no resolved note identity", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      { id: "inkbook" } as PluginManifest,
    );
    const runtime = new PluginRuntime(plugin, {
      recoveryStore: null,
      storagePolicy: await storagePolicy(),
    });
    runtime.register();
    const view = createEditor("Unresolved Markdown", runtimeExtensions(plugin));

    expect(runtime.sessionCount).toBe(0);
    expect(view.state.doc.toString()).toBe("Unresolved Markdown");

    view.destroy();
    await runtime.dispose();
  });

  it("fails closed when identity resolution throws and after disposal", async () => {
    const plugin = new InkbookPlugin(
      {} as App,
      { id: "inkbook" } as PluginManifest,
    );
    const runtime = new PluginRuntime(plugin, {
      noteIdentityResolver: {
        resolve: (): never => {
          throw new Error("host view unavailable");
        },
      },
      recoveryStore: null,
      storagePolicy: await storagePolicy(),
    });
    runtime.register();
    runtime.register();
    const extensions = runtimeExtensions(plugin);
    const unresolved = createEditor("Unresolved Markdown", extensions);

    expect(runtime.sessionCount).toBe(0);
    await runtime.dispose();
    runtime.register();
    const afterDisposal = createEditor("After disposal", extensions);
    expect(runtime.sessionCount).toBe(0);

    unresolved.destroy();
    unresolved.destroy();
    afterDisposal.destroy();
  });

  it("drains the session registry before disposing the Vault recovery store", async () => {
    const disposeRecovery = vi.fn(async (): Promise<void> => {
      expect(runtime.sessionCount).toBe(0);
    });
    const plugin = new InkbookPlugin(
      {} as App,
      { id: "inkbook" } as PluginManifest,
    );
    const runtime = new PluginRuntime(plugin, {
      noteIdentityResolver: {
        resolve: (): NoteIdentityV1 => SHARED_NOTE,
      },
      recoveryStore: { dispose: disposeRecovery } as unknown as RecoveryStore,
      storagePolicy: await storagePolicy(),
    });
    runtime.register();
    const view = createEditor("Markdown", runtimeExtensions(plugin));

    await runtime.dispose();
    view.destroy();

    expect(disposeRecovery).toHaveBeenCalledOnce();
  });
});

function createEditor(
  doc: string,
  extensions: readonly Extension[],
): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc, extensions }),
  });
}

function runtimeExtensions(plugin: InkbookPlugin): readonly Extension[] {
  return (
    plugin as unknown as { readonly editorExtensions: readonly Extension[] }
  ).editorExtensions;
}
