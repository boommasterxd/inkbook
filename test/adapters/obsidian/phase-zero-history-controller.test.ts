// @vitest-environment happy-dom

import { history, redo, undo } from "@codemirror/commands";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { IDBFactory } from "fake-indexeddb";
import type { Editor, MarkdownView } from "obsidian";
import { describe, expect, it } from "vitest";

import { PhaseZeroHistoryController } from "../../../src/adapters/obsidian/phase-zero-history-controller";
import {
  probeIndexedDbRecovery,
  type RecoveryIndexedDbStore,
} from "../../../src/adapters/recovery-indexed-db";
import { PhaseZeroViewRegistry } from "../../../src/adapters/obsidian/views";

const NOTE = {
  markdownPath: "note.md",
  vaultIdentityHint: "test-vault",
};
const HISTORY_SESSION_LIMIT = 32;
const HISTORY_SESSION_OVERFLOW_COUNT = HISTORY_SESSION_LIMIT + 1;

async function createStore(name: string): Promise<RecoveryIndexedDbStore> {
  const result = await probeIndexedDbRecovery({
    databaseName: name,
    indexedDb: new IDBFactory(),
  });
  if (result.kind !== "ready") throw new Error(result.reason);
  return result.store;
}

function markdownView(path = NOTE.markdownPath): MarkdownView {
  return {
    file: { path },
    getMode: (): "source" => "source",
  } as unknown as MarkdownView;
}

function editorFor(view: EditorView): Editor {
  return { cm: view } as unknown as Editor;
}

describe("PhaseZeroHistoryController", () => {
  it("preserves Markdown A, annotation B, and Markdown C in host order", async () => {
    const store = await createStore("history-order");
    const notices: string[] = [];
    const controller = new PhaseZeroHistoryController({
      getRecoveryStore: (): Promise<RecoveryIndexedDbStore> =>
        Promise.resolve(store),
      notice: (message): void => {
        notices.push(message);
      },
      vaultIdentityHint: NOTE.vaultIdentityHint,
      views: new PhaseZeroViewRegistry(),
    });
    const state = EditorState.create({
      doc: "A",
      extensions: [history(), controller.bridge.extension],
    });
    const view = new EditorView({ parent: document.body, state });

    await controller.insertProbeAnnotation(editorFor(view), markdownView());
    view.dispatch({ changes: { from: view.state.doc.length, insert: "C" } });
    expect(view.state.doc.toString()).toBe("AC");

    expect(undo(view)).toBe(true);
    await controller.settle();
    expect(view.state.doc.toString()).toBe("A");
    expect(undo(view)).toBe(true);
    await controller.settle();
    expect(view.state.doc.toString()).toBe("A");
    expect(redo(view)).toBe(true);
    await controller.settle();
    expect(redo(view)).toBe(true);
    await controller.settle();
    expect(view.state.doc.toString()).toBe("AC");

    const loaded = await store.loadNote(NOTE);
    expect(loaded).toMatchObject({ kind: "loaded" });
    if (loaded.kind === "loaded") {
      expect(loaded.records.map((record) => record.kind)).toEqual([
        "host-recorded-forward",
        "host-recorded-undo",
        "host-recorded-redo",
      ]);
    }
    expect(notices).toEqual([]);

    view.destroy();
    controller.dispose();
    await store.dispose();
  });

  it("fails closed when recovery cannot confirm a host-recorded effect", async () => {
    const durable = await createStore("history-recovery-failure");
    const store: RecoveryIndexedDbStore = {
      ...durable,
      deleteAttempt: (request) => durable.deleteAttempt(request),
      dispose: () => durable.dispose(),
      getByteUsage: (note) => durable.getByteUsage(note),
      loadNote: (note) => durable.loadNote(note),
      prepareForward: (record) => durable.prepareForward(record),
      recordDirection: (record) => durable.recordDirection(record),
      recordForward: async () => ({ kind: "quota-exceeded" }),
    };
    const notices: string[] = [];
    const controller = new PhaseZeroHistoryController({
      getRecoveryStore: (): Promise<RecoveryIndexedDbStore> =>
        Promise.resolve(store),
      notice: (message): void => {
        notices.push(message);
      },
      vaultIdentityHint: NOTE.vaultIdentityHint,
      views: new PhaseZeroViewRegistry(),
    });
    const view = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "A",
        extensions: [history(), controller.bridge.extension],
      }),
    });

    await controller.insertProbeAnnotation(editorFor(view), markdownView());

    expect(notices).toContain(
      "Inkbook history effect blocked: recovery-failed.",
    );
    expect(controller.status()).toContain("history fail-closed for 1 note(s)");
    await controller.insertProbeAnnotation(editorFor(view), markdownView());
    expect(notices).toContain("Inkbook annotation blocked: blocked.");

    view.destroy();
    controller.dispose();
    await durable.dispose();
  });
});

describe("PhaseZeroHistoryController ownership", () => {
  it("hands ownership to a new editor after the old host history is unreachable", async () => {
    const store = await createStore("history-epoch-handoff");
    const notices: string[] = [];
    const controller = new PhaseZeroHistoryController({
      getRecoveryStore: (): Promise<RecoveryIndexedDbStore> =>
        Promise.resolve(store),
      notice: (message): void => {
        notices.push(message);
      },
      vaultIdentityHint: NOTE.vaultIdentityHint,
      views: new PhaseZeroViewRegistry(),
    });
    const first = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "A",
        extensions: [history(), controller.bridge.extension],
      }),
    });
    const second = new EditorView({
      parent: document.body,
      state: EditorState.create({
        doc: "A",
        extensions: [history(), controller.bridge.extension],
      }),
    });

    await controller.insertProbeAnnotation(editorFor(first), markdownView());
    expect(undo(first)).toBe(true);
    await controller.settle();
    first.destroy();
    await controller.insertProbeAnnotation(editorFor(second), markdownView());
    await controller.settle();

    expect(notices).toEqual([]);
    second.destroy();
    controller.dispose();
    await store.dispose();
  });

  it("fails closed after the bounded history session capacity is reached", async () => {
    const store = await createStore("history-session-capacity");
    const notices: string[] = [];
    const controller = new PhaseZeroHistoryController({
      getRecoveryStore: (): Promise<RecoveryIndexedDbStore> =>
        Promise.resolve(store),
      notice: (message): void => {
        notices.push(message);
      },
      vaultIdentityHint: NOTE.vaultIdentityHint,
      views: new PhaseZeroViewRegistry(),
    });
    const views: EditorView[] = [];

    for (let index = 0; index < HISTORY_SESSION_OVERFLOW_COUNT; index += 1) {
      const view = new EditorView({
        parent: document.body,
        state: EditorState.create({
          doc: "A",
          extensions: [history(), controller.bridge.extension],
        }),
      });
      views.push(view);
      await controller.insertProbeAnnotation(
        editorFor(view),
        markdownView(`capacity-${String(index)}.md`),
      );
    }

    expect(notices).toEqual([
      "Inkbook annotation blocked: history session capacity exceeded.",
    ]);
    for (const view of views) view.destroy();
    controller.dispose();
    await store.dispose();
  });
});
