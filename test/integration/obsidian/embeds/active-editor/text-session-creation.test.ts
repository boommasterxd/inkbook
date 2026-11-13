// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import type { ActiveTextSession } from "../../../../../src/obsidian/embeds/active-editor/text-session";
import { registerAppliedDocumentMutation } from "../../../../../src/obsidian/embeds/active-editor/document-history";
import { PreparedElementHistory } from "../../../../../src/obsidian/embeds/active-editor/prepared-element-history";
import { SelectionHandleSession } from "../../../../../src/editor/selection/public";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import {
  activeTextLayout,
  mountActiveTextSession,
} from "../../../../fixtures/obsidian/active-text-session";
import { indexedStroke } from "../../../../fixtures/editor/stroke";

const sessions: ActiveTextSession[] = [];
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function mount() {
  const state = mountActiveTextSession();
  sessions.push(state.session);
  return state;
}

const box = { x: 20, y: 40, width: 240 };
const exits = ["escape", "outside", "export"] as const;

function expectCreationReleased(state: ReturnType<typeof mount>): void {
  expect(state.model.store.size).toBe(1);
  expect(state.history.commandCount).toBe(0);
  expect(state.operations()).toBe(0);
  expect(state.hasExportPreparation()).toBe(false);
}

async function leaveCreation(state: ReturnType<typeof mount>, exit: (typeof exits)[number]) {
  if (exit === "outside") state.outside(document.body);
  else if (exit === "escape")
    state.input().contentDOM.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
  else await state.prepareExport();
  await vi.waitFor(() => expect(state.session.active).toBe(false));
}

function emphasizeDraft(state: ReturnType<typeof mount>): void {
  expect(state.session.applyStyle("text-bold", true)).toBe(true);
  expect(state.session.applyStyle("text-italic", true)).toBe(true);
}

async function expectPriorRedoWithoutDraft(state: ReturnType<typeof mount>, draftId: string) {
  await expect(state.history.redoAsync()).resolves.toBe(true);
  expect(state.model.store.size).toBe(2);
  expect(state.model.store.get(draftId)).toBeUndefined();
  expect(state.error).not.toHaveBeenCalled();
}

async function resizeActiveText(state: ReturnType<typeof mount>) {
  await expect(state.session.suspendForGeometry()).resolves.toBe(true);
  const element = state.model.store.get(state.session.activeId!)?.element;
  if (element?.kind !== "text") throw new Error("Missing text resize target");
  const startPointer = { x: element.x + element.width, y: element.y + element.height / 2 };
  const handle = new SelectionHandleSession({
    action: {
      kind: "scale",
      position: "middle-right",
      rotation: 0,
      anchor: { x: element.x, y: startPointer.y },
    },
    elements: [element as TextElementV2],
    planner: state.model.store,
    startPointer,
    reflowText: async (next) => activeTextLayout(next),
  });
  const prepared = new PreparedElementHistory({
    model: state.model,
    history: state.history,
    isAttached: () => true,
    motion: state.renderer,
    onPendingChanged: vi.fn(),
    workScheduler: immediateWorkScheduler(),
    registerApplied: (...args) => state.session.registerProvisionalGeometryHistory(...args),
  });
  const effect = { apply: vi.fn(), revert: vi.fn() };
  const completed = vi.fn();
  try {
    handle.update({ ...startPointer, x: startPointer.x + 80 });
    expect(prepared.commitHandle(handle, completed, () => effect)).toBe(true);
    await vi.waitFor(() => expect(completed).toHaveBeenCalledWith(true));
    expect(state.model.store.get(element.id)?.element).toMatchObject({
      width: element.width + 80,
    });
    expect(effect.apply).toHaveBeenCalledOnce();
    await expect(state.session.resumeAfterGeometry()).resolves.toBe(true);
    return effect;
  } finally {
    handle.cancel();
    prepared.dispose();
  }
}

it.each(exits)(
  "discards an untouched creation on %s without retaining a ghost or consuming redo",
  async (exit) => {
    const state = mount();
    await state.session.create(box, "Previous creation", false);
    await state.history.undoAsync();
    expect(state.history.canRedo).toBe(true);
    await state.session.create(box);
    const id = state.session.activeId!;
    expect(state.model.store.get(id)?.element).toMatchObject({ source: "" });
    expect(state.history.commandCount).toBe(1);
    expect(state.operations()).toBe(1);
    await leaveCreation(state, exit);
    expect(state.model.store.get(id)).toBeUndefined();
    expect(state.selection).toHaveBeenLastCalledWith(new Set());
    expect(state.operations()).toBe(0);
    expect(state.hasExportPreparation()).toBe(false);
    expect(state.history.commandCount).toBe(1);
    await expectPriorRedoWithoutDraft(state, id);
  },
);

it("discards whitespace drafts after native input preparation and preserves existing empty fields", async () => {
  const state = mount();
  await state.session.create(box);
  const id = state.session.activeId!;
  state.input().dispatch({ changes: { from: 0, insert: " \n\t " } });
  expect(state.history.commandCount).toBe(0);
  expect(state.operations()).toBe(2);
  await expect(state.session.finish()).resolves.toBe(true);
  expect(state.model.store.get(id)).toBeUndefined();
  expect(state.history.canUndo).toBe(false);
  expect(state.operations()).toBe(0);
  await state.session.edit(state.element.id);
  state.input().dispatch({ changes: { from: 0, to: 5, insert: "" } });
  await state.session.finish();
  expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source: "" });
});

it("accepts the first actual text as creation and keeps subsequent text undo and redo independent", async () => {
  const state = mount();
  await state.session.create(box);
  const id = state.session.activeId!;
  state.input().dispatch({ changes: { from: 0, insert: "First" } });
  await state.session.flush();
  expect(state.operations()).toBe(0);
  expect(state.history.commandCount).toBe(1);
  state.input().dispatch({ changes: { from: 5, insert: " second" } });
  await state.session.finish();
  expect(state.history.commandCount).toBe(2);
  for (let replay = 0; replay < 2; replay += 1) {
    await expect(state.history.undoAsync()).resolves.toBe(true);
    expect(state.model.store.get(id)?.element).toMatchObject({ source: "First" });
    await expect(state.history.undoAsync()).resolves.toBe(true);
    expect(state.model.store.get(id)).toBeUndefined();
    await expect(state.history.redoAsync()).resolves.toBe(true);
    expect(state.model.store.get(id)?.element).toMatchObject({ source: "First" });
    await expect(state.history.redoAsync()).resolves.toBe(true);
    expect(state.model.store.get(id)?.element).toMatchObject({ source: "First second" });
  }
  expect(state.error).not.toHaveBeenCalled();
});

it("waits for pending empty creation before finishing", async () => {
  const state = mount();
  let release = () => undefined as void;
  const waiting = new Promise<void>((resolve) => {
    release = resolve;
  });
  state.prepare.mockImplementationOnce(async (element) => {
    await waiting;
    return activeTextLayout(element);
  });
  const creating = state.session.create(box);
  await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
  const finishing = state.session.finish();
  release();
  await expect(creating).resolves.toBe(true);
  await expect(finishing).resolves.toBe(true);
  expectCreationReleased(state);
});

it("prevents an in-flight creation from committing after disposal", async () => {
  const state = mount();
  state.prepare.mockImplementationOnce(async (element) => {
    await Promise.resolve();
    state.session.dispose();
    return activeTextLayout(element);
  });
  await expect(state.session.create(box)).resolves.toBe(false);
  expectCreationReleased(state);
  expect(state.error).not.toHaveBeenCalled();
});

it("removes a provisional field if renderer readiness fails while opening", async () => {
  const state = mount();
  vi.spyOn(state.renderer, "waitForTextElement").mockRejectedValue(new Error("Readiness failed"));
  await expect(state.session.create(box)).resolves.toBe(false);
  expectCreationReleased(state);
  expect(state.selection).toHaveBeenLastCalledWith(new Set());
});

it("retains text typed while an empty-field discard is being prepared", async () => {
  const state = mount();
  await state.session.create(box);
  const id = state.session.activeId!;
  const original = state.model.prepareElementRemoval.bind(state.model);
  let entered = false;
  let release = () => undefined as void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(state.model, "prepareElementRemoval").mockImplementationOnce(async (...args) => {
    entered = true;
    await wait;
    return original(...args);
  });
  const finishing = state.session.finish();
  await vi.waitFor(() => expect(entered).toBe(true));
  state.input().dispatch({ changes: { from: 0, insert: "Keep me" } });
  release();
  await expect(finishing).resolves.toBe(false);
  await expect(state.session.finish()).resolves.toBe(true);
  expect(state.model.store.get(id)?.element).toMatchObject({ source: "Keep me" });
  expect(state.history.commandCount).toBe(1);
  expect(state.operations()).toBe(0);
  expect(state.error).not.toHaveBeenCalled();
});

it("retains an empty draft for retry if its prepared removal fails", async () => {
  const state = mount();
  await state.session.create(box);
  const id = state.session.activeId!;
  vi.spyOn(state.model, "prepareElementRemoval").mockRejectedValueOnce(new Error("Removal failed"));
  await expect(state.session.finish()).resolves.toBe(false);
  expect(state.session.active).toBe(true);
  expect(state.operations()).toBe(1);
  expect(state.model.store.get(id)).toBeDefined();
  await expect(state.session.finish()).resolves.toBe(true);
  expectCreationReleased(state);
});

it.each(exits)(
  "discards a formatting-only creation on %s without accepting generated Markdown as user input",
  async (exit) => {
    const state = mount();
    await state.session.create(box);
    const id = state.session.activeId!;
    for (const flag of ["bold", "italic", "strikethrough", "underline"])
      expect(state.session.applyStyle(`text-${flag}`, true)).toBe(true);
    expect(state.session.applyStyle("color", "#3B82F6FF")).toBe(true);
    expect(state.session.applyStyle("text-background-color", "#EAB308FF")).toBe(true);
    await state.session.flush();
    const element = state.model.store.get(id)?.element;
    if (element?.kind !== "text") throw new Error("Missing provisional text");
    expect(element.source.trim().length).toBeGreaterThan(0);
    expect(state.history.commandCount).toBe(0);
    expect(state.operations()).toBe(1);
    await leaveCreation(state, exit);
    expectCreationReleased(state);
    await expect(state.history.redoAsync()).resolves.toBe(false);
    expect(state.model.store.get(id)).toBeUndefined();
  },
);

it.each(["a", "*", "$"])(
  "keeps a styled creation after genuine input %s, including literal Markdown characters",
  async (source) => {
    const state = mount();
    await state.session.create(box);
    const id = state.session.activeId!;
    emphasizeDraft(state);
    await state.session.flush();
    const view = state.input();
    view.dispatch(view.state.replaceSelection(source));
    const expectedSource = view.state.doc.toString();
    await state.session.finish();
    const element = state.model.store.get(id)?.element;
    if (element?.kind !== "text") throw new Error("Missing accepted text");
    expect(element.source).toBe(expectedSource);
    expect(state.history.commandCount).toBe(1);
    expect(state.operations()).toBe(0);
    await state.history.undoAsync();
    expect(state.model.store.get(id)).toBeUndefined();
    await state.history.redoAsync();
    expect(state.model.store.get(id)?.element).toMatchObject({ source: element.source });
  },
);

it.each(["", " \n\t "])(
  "ignores whitespace-only clipboard creation %j without side effects",
  async (source) => {
    const state = mount();
    await expect(state.session.create(box, source, false)).resolves.toBe(false);
    expectCreationReleased(state);
    expect(state.selection).not.toHaveBeenCalled();
    expect(state.prepare).not.toHaveBeenCalled();
  },
);

it("uses Ctrl+Z only to cancel a formatting-only text draft and preserves the previous stroke", async () => {
  const state = mount();
  const stroke = indexedStroke(77);
  const prepared = await state.model.prepareElementAppend([stroke], { isCancelled: () => false });
  if (prepared.token === null) throw new Error("Missing stroke append");
  const applied = state.model.commitPreparedElementMutation(prepared.token);
  if (applied === null) throw new Error("Missing stroke history");
  registerAppliedDocumentMutation(state.history, state.model, applied);
  await state.session.create(box);
  const id = state.session.activeId!;
  emphasizeDraft(state);
  const key = new KeyboardEvent("keydown", { key: "z", ctrlKey: true, bubbles: true });
  state.input().contentDOM.dispatchEvent(key);
  await vi.waitFor(() => expect(state.session.active).toBe(false));
  expect(state.model.store.get(id)).toBeUndefined();
  expect(state.model.store.get(stroke.id)?.element.kind).toBe("stroke");
  expect(state.history.commandCount).toBe(1);
  expect(state.history.canUndo).toBe(true);
  expect(state.history.canRedo).toBe(false);
  expect(state.operations()).toBe(0);
  expect(state.error).not.toHaveBeenCalled();
});

it("discards a resized formatting-only draft without retaining geometry undo or replacing prior history", async () => {
  const state = mount();
  await state.session.create(box, "Previous", false);
  await state.session.create(box);
  const id = state.session.activeId!;
  emphasizeDraft(state);
  const input = state.input();
  await resizeActiveText(state);
  expect(state.input()).toBe(input);
  expect(state.history.commandCount).toBe(1);
  await state.session.finish();
  expect(state.model.store.get(id)).toBeUndefined();
  expect(state.operations()).toBe(0);
  await expect(state.history.undoAsync()).resolves.toBe(true);
  expect(state.model.store.size).toBe(1);
  await expectPriorRedoWithoutDraft(state, id);
});

it("keeps normal geometry undo when resizing an existing field while its source editor stays mounted", async () => {
  const state = mount();
  await state.session.edit(state.element.id);
  const input = state.input();
  const effect = await resizeActiveText(state);
  expect(state.input()).toBe(input);
  expect(state.history.commandCount).toBe(1);
  await state.session.finish();
  await expect(state.history.undoAsync()).resolves.toBe(true);
  expect(state.model.store.get(state.element.id)?.element).toMatchObject({
    width: state.element.width,
  });
  expect(effect.revert).toHaveBeenCalledOnce();
  await expect(state.history.redoAsync()).resolves.toBe(true);
  expect(state.model.store.get(state.element.id)?.element).toMatchObject({
    width: state.element.width + 80,
  });
  expect(effect.apply).toHaveBeenCalledTimes(2);
  expect(state.error).not.toHaveBeenCalled();
});
