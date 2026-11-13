// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { useActiveTextSessions } from "../../../../fixtures/obsidian/active-text-session";
import type { TextEditingCallbacks } from "../../../../../src/rendering/scene/text-editing-surface";

const mount = useActiveTextSessions();

async function focusedInput(state: ReturnType<typeof mount>) {
  await state.session.edit(state.element.id);
  const input = state.input();
  input.contentDOM.focus();
  return { input, dispatch: vi.spyOn(input, "dispatch") };
}

function pendingSurface() {
  const state = mount();
  const begin = vi.mocked(state.renderer.beginTextEditing);
  const original = begin.getMockImplementation()!;
  let release!: () => void;
  let reject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, fail) => {
    release = resolve;
    reject = fail;
  });
  begin.mockImplementation((...args) => ({ ...original(...args)!, ready }));
  return {
    ...state,
    begin,
    release: () => release(),
    reject: () => reject(new Error("Unavailable input document")),
  };
}

it("mounts one native editor only after its input document assets are ready", async () => {
  const state = pendingSurface();
  const opening = state.session.edit(state.element.id);
  await vi.waitFor(() => expect(state.begin).toHaveBeenCalledOnce());
  expect(state.container.querySelector(".cm-editor")).toBeNull();
  state.release();
  await expect(opening).resolves.toBe(true);
  expect(state.container.querySelectorAll(".cm-editor")).toHaveLength(1);
  expect(state.error).not.toHaveBeenCalled();
});

it.each(["dispose", "reject"] as const)(
  "cleans an opening document on %s without mounting native input",
  async (outcome) => {
    const state = pendingSurface();
    const opening = state.session.edit(state.element.id);
    await vi.waitFor(() => expect(state.begin).toHaveBeenCalledOnce());
    if (outcome === "dispose") {
      state.session.dispose();
      state.release();
    } else state.reject();
    await expect(opening).resolves.toBe(false);
    expect(state.container.querySelector(".cm-editor")).toBeNull();
    expect(state.dispose).toHaveBeenCalled();
    expect(state.selection).not.toHaveBeenCalled();
    expect(state.error).toHaveBeenCalledTimes(outcome === "reject" ? 1 : 0);
  },
);

it("reopens a replaced document through normal save and input lifecycle with source and caret preserved", async () => {
  const state = mount();
  const begin = vi.mocked(state.renderer.beginTextEditing);
  const original = begin.getMockImplementation()!;
  let callbacks: TextEditingCallbacks | undefined;
  begin.mockImplementation((id, next) => {
    callbacks = next;
    return original(id, next);
  });
  await state.session.edit(state.element.id);
  state.input().dispatch({
    changes: { from: 0, to: state.input().state.doc.length, insert: "Preserved source" },
    selection: { anchor: 7 },
  });
  callbacks?.onDocumentInvalidated?.();
  await vi.waitFor(() => expect(begin).toHaveBeenCalledTimes(2));
  await vi.waitFor(() => expect(state.container.querySelectorAll(".cm-editor")).toHaveLength(1));
  expect(state.input().state.doc.toString()).toBe("Preserved source");
  expect(state.input().state.selection.main.anchor).toBe(7);
  expect(state.dispose).toHaveBeenCalledOnce();
  expect(state.error).not.toHaveBeenCalled();
});

it("requests caret reveal after a focused source commit adopts its final input bounds", async () => {
  const state = mount();
  const { input, dispatch } = await focusedInput(state);
  const requestIndices = () =>
    dispatch.mock.calls.flatMap(([spec], index) =>
      spec && "scrollIntoView" in spec && spec.scrollIntoView === true ? [index] : [],
    );
  input.dispatch({
    changes: { from: 0, to: input.state.doc.length, insert: "Pasted source\nSecond line" },
    selection: { anchor: 25 },
  });
  await expect(state.session.flush()).resolves.toBe(true);
  const requests = requestIndices();
  expect(requests).toHaveLength(1);
  expect(dispatch.mock.invocationCallOrder[requests[0]!]).toBeGreaterThan(
    state.bounds.mock.invocationCallOrder[state.bounds.mock.invocationCallOrder.length - 1]!,
  );
  expect(state.input()).toBe(input);
  expect(input.state.selection.main.anchor).toBe(25);
  input.contentDOM.blur();
  dispatch.mockClear();
  input.dispatch({ changes: { from: 0, insert: "Next " } });
  await state.session.flush();
  expect(requestIndices()).toHaveLength(0);
});

it("does not reveal a source commit while a handle acquires geometry ownership", async () => {
  const state = mount();
  const { input, dispatch } = await focusedInput(state);
  input.dispatch({ changes: { from: 0, insert: "Pending " } });
  await expect(state.session.suspendForGeometry()).resolves.toBe(true);
  expect(
    dispatch.mock.calls.filter(
      ([spec]) => spec && "scrollIntoView" in spec && spec.scrollIntoView === true,
    ),
  ).toHaveLength(0);
  await state.session.resumeAfterGeometry();
});
