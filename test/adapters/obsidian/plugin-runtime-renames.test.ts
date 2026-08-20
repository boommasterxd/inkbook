// @vitest-environment happy-dom

import { EditorState, type Extension } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import {
  TFile,
  TFolder,
  type App,
  type PluginManifest,
  type Vault,
} from "obsidian";
import { describe, expect, it, vi } from "vitest";

import InkbookPlugin from "../../../src/main";
import { PluginRuntime } from "../../../src/adapters/obsidian/plugin-runtime";
import type { NoteIdentityV1 } from "../../../src/application/note-session";
import { createSidecarStoragePolicyStore } from "../../../src/application/persistence";

const VAULT_ID = "0123456789abcdef0123456789abcdef";

describe("PluginRuntime Vault rename integration", () => {
  it("rekeys two pane references after one concrete Markdown file rename", async () => {
    const source = identity("Notes/shared.md");
    const target = identity("Archive/shared.md");
    const harness = await runtimeHarness([source, source]);
    const first = createEditor(harness.extensions);
    const second = createEditor(harness.extensions);

    harness.rename(
      hostFile(target.vaultRelativeMarkdownPath),
      source.vaultRelativeMarkdownPath,
    );
    await harness.runtime.whenVaultEventsIdle();

    expect(harness.runtime.referenceCount(source)).toBe(0);
    expect(harness.runtime.referenceCount(target)).toBe(Number("2"));
    first.destroy();
    second.destroy();
    await harness.runtime.dispose();
  });

  it("rekeys an open note under one concrete folder rename", async () => {
    const source = identity("Notes/Topic/page.md");
    const target = identity("Archive/Topic/page.md");
    const harness = await runtimeHarness([source]);
    const view = createEditor(harness.extensions);

    harness.rename(hostFolder("Archive"), "Notes");
    await harness.runtime.whenVaultEventsIdle();

    expect(harness.runtime.referenceCount(source)).toBe(0);
    expect(harness.runtime.referenceCount(target)).toBe(1);
    view.destroy();
    await harness.runtime.dispose();
  });

  it("rejects collision and stale rename events without partial rekey", async () => {
    const source = identity("Notes/a.md");
    const target = identity("Notes/b.md");
    const harness = await runtimeHarness([source, target]);
    const first = createEditor(harness.extensions);
    const second = createEditor(harness.extensions);

    harness.rename(
      hostFile(target.vaultRelativeMarkdownPath),
      source.vaultRelativeMarkdownPath,
    );
    harness.rename(hostFile("Notes/c.md"), "Notes/missing.md");
    await harness.runtime.whenVaultEventsIdle();

    expect(harness.runtime.referenceCount(source)).toBe(1);
    expect(harness.runtime.referenceCount(target)).toBe(1);
    first.destroy();
    second.destroy();
    await harness.runtime.dispose();
  });

  it("drains an accepted rename before idempotent disposal", async () => {
    const source = identity("Notes/a.md");
    const harness = await runtimeHarness([source]);
    const view = createEditor(harness.extensions);

    harness.rename(hostFile("Archive/a.md"), source.vaultRelativeMarkdownPath);
    const first = harness.runtime.dispose();
    const second = harness.runtime.dispose();

    expect(second).toBe(first);
    await first;
    view.destroy();
    expect(harness.runtime.sessionCount).toBe(0);
  });

  it("ignores invalid, unrelated, and post-disposal rename events", async () => {
    const source = identity("Notes/a.md");
    const harness = await runtimeHarness([source]);
    const view = createEditor(harness.extensions);

    harness.rename(hostFile("Archive/a.md"), ".obsidian/a.md");
    harness.rename(
      hostFile(".obsidian/a.md"),
      source.vaultRelativeMarkdownPath,
    );
    harness.rename(hostFolder("Archive"), "");
    harness.rename(hostFolder(".obsidian"), "Notes");
    harness.rename(
      { path: "Archive/a.md" } as TFile,
      source.vaultRelativeMarkdownPath,
    );
    await harness.runtime.whenVaultEventsIdle();

    expect(harness.runtime.referenceCount(source)).toBe(1);
    await harness.runtime.dispose();
    harness.rename(hostFile("Archive/a.md"), source.vaultRelativeMarkdownPath);
    await harness.runtime.whenVaultEventsIdle();
    expect(harness.runtime.sessionCount).toBe(0);
    view.destroy();
  });
});

interface RuntimeHarnessV1 {
  readonly runtime: PluginRuntime;
  readonly extensions: readonly Extension[];
  rename(target: TFile | TFolder, oldPath: string): void;
}

async function runtimeHarness(
  resolvedIdentities: readonly NoteIdentityV1[],
): Promise<RuntimeHarnessV1> {
  const callbacks = new Map<string, (...values: unknown[]) => void>();
  const vault = {
    on: vi.fn((name: string, callback: (...values: unknown[]) => void) => {
      callbacks.set(name, callback);
      return { name };
    }),
  } as unknown as Vault;
  const plugin = new InkbookPlugin(
    { vault } as App,
    { id: "inkbook" } as PluginManifest,
  );
  const pending = [...resolvedIdentities];
  const runtime = new PluginRuntime(plugin, {
    noteIdentityResolver: {
      resolve: (): NoteIdentityV1 | null => pending.shift() ?? null,
    },
    recoveryStore: null,
    storagePolicy: await createSidecarStoragePolicyStore({
      loadData: async () => null,
      saveData: async () => undefined,
    }),
    vaultId: VAULT_ID,
  });
  runtime.register();
  return {
    extensions: (
      plugin as unknown as { readonly editorExtensions: readonly Extension[] }
    ).editorExtensions,
    rename: (target, oldPath): void => {
      callbacks.get("rename")?.(target, oldPath);
    },
    runtime,
  };
}

function createEditor(extensions: readonly Extension[]): EditorView {
  return new EditorView({
    parent: document.body,
    state: EditorState.create({ doc: "Markdown", extensions }),
  });
}

function identity(path: string): NoteIdentityV1 {
  return Object.freeze({
    vaultIdHint: VAULT_ID,
    vaultRelativeMarkdownPath: path,
  });
}

function hostFile(path: string): TFile {
  return hostPath(TFile.prototype, path) as TFile;
}

function hostFolder(path: string): TFolder {
  return hostPath(TFolder.prototype, path) as TFolder;
}

function hostPath(prototype: object, path: string): object {
  const target = Object.create(prototype) as object;
  Object.defineProperty(target, "path", { value: path });
  return target;
}
