// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import type { EditorView } from "@codemirror/view";
import type { EditorSelection } from "@codemirror/state";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";
import type { TextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";
import { parseTextMarkdown } from "../../../../fixtures/domain/text-source";
import {
  activeTextLayout,
  openTextSessionRange,
  useActiveTextSessions,
} from "../../../../fixtures/obsidian/active-text-session";
import { ActiveTextPreparation } from "../../../../../src/obsidian/embeds/active-editor/text-preparation";
import { textElement } from "../../../../unit/domain/schema/fixtures";

const mount = useActiveTextSessions();

function deferred() {
  let release = () => undefined as void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release: () => release() };
}

async function replaceGeometry(state: ReturnType<typeof mount>, width = 400) {
  const previous = state.model.store.get(state.element.id)!.element as TextElementV2;
  const element = activeTextLayout({ ...previous, width, x: 80, y: 120, rotation: 30 });
  const prepared = await state.model.prepareElementReplacement([element], {
    isCancelled: () => false,
  });
  if (prepared.status !== "prepared" || !prepared.token)
    throw new Error("Expected geometry replacement.");
  expect(state.model.commitPreparedElementReplacement(prepared.token)).toBe("committed");
  return state.model.store.get(element.id)!.element as TextElementV2;
}

async function resumeRetainedInput(
  state: ReturnType<typeof mount>,
  input: EditorView,
  selection: EditorSelection,
) {
  await expect(state.session.resumeAfterGeometry()).resolves.toBe(true);
  expect(state.input()).toBe(input);
  expect(input.state.selection.main).toMatchObject({
    anchor: selection.main.anchor,
    head: selection.main.head,
  });
  expect(state.session.geometrySuspended).toBe(false);
}

describe("normalized native source geometry", () => {
  it.each(["\r\n", "\r"])(
    "retains normalized native source and selection through geometry previews of %j line endings",
    async (separator) => {
      const source = `One${separator}Two`;
      const state = mount({
        ...textElement(),
        source,
        ranges: [{ start: source.indexOf("Two"), end: source.length, style: { fontSize: 30 } }],
      });
      await state.session.edit(state.element.id);
      const input = state.input();
      input.contentDOM.blur();
      input.dispatch({ selection: { anchor: 4, head: 7 } });
      const selection = input.state.selection;
      await expect(state.session.suspendForGeometry()).resolves.toBe(true);
      const canonical = state.model.store.get(state.element.id)!.element as TextElementV2;
      const history = state.history.commandCount;
      const nativeSource = input.state.doc;
      state.geometryChanged(activeTextLayout({ ...canonical, width: canonical.width + 200 }));
      const scaled = {
        ...canonical,
        style: { ...canonical.style, fontSize: 45 },
        ranges: canonical.ranges.map((range) => ({ ...range, style: { fontSize: 45 } })),
      };
      state.geometryChanged(activeTextLayout(scaled));
      await state.session.flush();
      expect(input.state.doc).toBe(nativeSource);
      expect(state.session.styleSummary()?.style.fontSize).toBe(45);
      await resumeRetainedInput(state, input, selection);
      expect(input.state.doc).toBe(nativeSource);
      expect(input.state.doc.toString()).toBe("One\nTwo");
      expect(state.session.styleSummary()?.style.fontSize).toBe(30);
      expect(state.history.commandCount).toBe(history);
      expect(state.model.store.get(state.element.id)!.element).toMatchObject({ source });
      input.dispatch({ changes: { from: 7, insert: "!" }, selection: { anchor: 8 } });
      await expect(state.session.flush()).resolves.toBe(true);
      expect(state.model.store.get(state.element.id)!.element).toMatchObject({
        source: "One\nTwo!",
        ranges: [{ start: 4, end: 8, style: { fontSize: 30 } }],
      });
      expect(state.error).not.toHaveBeenCalled();
    },
  );
});

describe("active text geometry handoff", () => {
  it("reflows the retained source editor during resize without discarding empty tail lines or committing previews", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const input = state.input();
    input.dispatch({ selection: { anchor: input.state.doc.length } });
    input.dispatch(input.state.replaceSelection("\n\n"));
    await state.session.suspendForGeometry();
    const canonical = state.model.store.get(state.element.id)!.element as TextElementV2;
    const history = state.history.commandCount;
    const preview = activeTextLayout({ ...canonical, width: canonical.width + 200 });
    const selection = input.state.selection;
    state.geometryChanged(preview);
    expect(state.input()).toBe(input);
    expect(input.state.doc.toString()).toBe("Hello\n\n");
    expect(input.state.selection).toEqual(selection);
    expect(state.bounds).toHaveBeenLastCalledWith(preview, preview);
    expect(state.model.store.get(state.element.id)!.element).toBe(canonical);
    expect(state.history.commandCount).toBe(history);
    await resumeRetainedInput(state, input, selection);
    expect(state.bounds).toHaveBeenLastCalledWith(canonical, canonical);
    expect(state.error).not.toHaveBeenCalled();
  });

  it("flushes native input and resumes the same editor, caret and pending marks after store geometry changes", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    expect(state.error).not.toHaveBeenCalled();
    const input = state.input();
    input.dispatch({ selection: { anchor: input.state.doc.length } });
    state.session.applyStyle("text-bold", true);
    state.session.applyStyle("text-italic", true);
    input.dispatch(input.state.replaceSelection("before"));
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({ source: "Hello" });
    await expect(state.session.suspendForGeometry()).resolves.toBe(true);
    const selection = input.state.selection;
    expect((state.model.store.get(state.element.id)!.element as TextElementV2).source).toContain(
      "before",
    );
    expect(state.session.geometrySuspended).toBe(true);
    expect(state.suspended).toHaveBeenCalledExactlyOnceWith(true);
    const preparations = state.prepare.mock.calls.length;
    const element = await replaceGeometry(state);
    await resumeRetainedInput(state, input, selection);
    expect(state.session.styleSummary()?.style).toMatchObject({ bold: true, italic: true });
    expect(state.bounds).toHaveBeenLastCalledWith(element, element);
    expect(state.renderer.beginTextEditing).toHaveBeenCalledOnce();
    expect(state.prepare).toHaveBeenCalledTimes(preparations);
    expect(state.operations()).toBe(0);
    expect(state.dispose).not.toHaveBeenCalled();
    input.dispatch(input.state.replaceSelection("after"));
    await state.session.flush();
    const saved = state.model.store.get(element.id)!.element as TextElementV2;
    expect(saved).toMatchObject({ width: element.width, x: element.x, rotation: element.rotation });
    const runs = parseTextMarkdown(saved.source, saved).blocks.flatMap((block) => block.runs);
    expect(runs.find((run) => run.kind === "text" && run.text.includes("after"))).toMatchObject({
      style: { bold: true, italic: true },
    });
    expect(state.error).not.toHaveBeenCalled();
  });

  it("restores an unchanged field with the same source selection and no history step", async () => {
    const state = mount();
    const input = await openTextSessionRange(state, { anchor: 1, head: 4 });
    const selection = input.state.selection;
    await expect(state.session.suspendForGeometry()).resolves.toBe(true);
    await resumeRetainedInput(state, input, selection);
    expect(state.history.commandCount).toBe(0);
    expect(state.suspended.mock.calls).toEqual([[true], [false]]);
  });

  it("keeps failed native source available and refuses suspension until its canonical preparation succeeds", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const input = state.input();
    state.prepare.mockRejectedValueOnce(new Error("Font unavailable"));
    input.dispatch({ changes: { from: 5, insert: " retained" } });
    await expect(state.session.suspendForGeometry()).resolves.toBe(false);
    expect(state.session.geometrySuspended).toBe(false);
    expect(state.suspended).not.toHaveBeenCalled();
    expect(state.input()).toBe(input);
    expect(input.state.doc.toString()).toBe("Hello retained");
    await expect(state.session.suspendForGeometry()).resolves.toBe(true);
    await expect(state.session.resumeAfterGeometry()).resolves.toBe(true);
    expect(state.model.store.get(state.element.id)?.element).toMatchObject({
      source: "Hello retained",
    });
    expect(state.error).toHaveBeenCalledOnce();
  });
});

describe("prepared native geometry publication", () => {
  it("publishes prepared fonts with the matching bounds even after the gesture aligns the field", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const input = state.input();
    await state.session.suspendForGeometry();
    const canonical = state.model.store.get(state.element.id)!.element as TextElementV2;
    const selection = input.state.selection;
    const document = input.state.doc;
    const font = () =>
      state.container.querySelector<HTMLElement>(".inkbook-text-run")!.style.fontSize;
    expect(font()).toBe(`${canonical.style.fontSize}px`);
    const prepared = await state.session.reflow(
      { ...canonical, width: 700, style: { ...canonical.style, fontSize: 45 } },
      new AbortController().signal,
    );
    expect(font()).toBe(`${canonical.style.fontSize}px`);
    state.geometryChanged({ ...canonical, x: 60 });
    state.bounds.mockImplementationOnce(() => {
      expect(font()).toBe("45px");
      input.dom.style.height = "330.375px";
    });
    const styles = vi.spyOn(window, "getComputedStyle");
    const heightReads = () => styles.mock.calls.filter(([target]) => target === input.dom).length;
    const reads = heightReads();
    state.geometryChanged({ ...prepared, x: 120, y: 160, pivot: { x: 470, y: 200 } });
    const surface = vi.mocked(state.renderer.beginTextEditing).mock.results[0]!
      .value as TextEditingSurface;
    expect(heightReads() - reads).toBe(1);
    expect(surface.setContentHeight).toHaveBeenLastCalledWith(330.375);
    expect(font()).toBe("45px");
    expect(input.state.doc).toBe(document);
    expect(input.state.selection).toBe(selection);
    expect(state.history.commandCount).toBe(0);
    await resumeRetainedInput(state, input, selection);
    expect(font()).toBe(`${canonical.style.fontSize}px`);
    expect(state.error).not.toHaveBeenCalled();
  });
});

describe("active text geometry settlement", () => {
  it("retains current geometry and the native input when font reopening fails", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    const input = state.input();
    await state.session.suspendForGeometry();
    const element = await replaceGeometry(state, 800);
    vi.spyOn(ActiveTextPreparation.prototype, "open").mockRejectedValueOnce(
      new Error("Font unavailable"),
    );
    await expect(state.session.resumeAfterGeometry()).resolves.toBe(false);
    expect(state.input()).toBe(input);
    expect(state.session.active).toBe(true);
    expect(state.session.geometrySuspended).toBe(false);
    expect(state.suspended).toHaveBeenLastCalledWith(false);
    expect(state.error).toHaveBeenCalledOnce();
    input.dispatch({ changes: { from: 5, insert: " recovered" } });
    await expect(state.session.flush()).resolves.toBe(true);
    expect(state.model.store.get(element.id)?.element).toMatchObject({
      width: 800,
      source: "Hello recovered",
    });
  });

  it("waits to finish until the geometry owner resumes the retained input", async () => {
    const state = mount();
    await state.session.edit(state.element.id);
    await state.session.suspendForGeometry();
    const finishing = state.session.finish();
    await Promise.resolve();
    expect(state.dispose).not.toHaveBeenCalled();
    expect(state.session.active).toBe(true);
    await expect(state.session.resumeAfterGeometry()).resolves.toBe(true);
    await expect(finishing).resolves.toBe(true);
    expect(state.session.active).toBe(false);
    expect(state.dispose).toHaveBeenCalledOnce();
    expect(state.operations()).toBe(0);
  });

  it.each(["source", "renderer"] as const)(
    "unblocks pending %s and finish ownership on disposal",
    async (boundary) => {
      const state = mount();
      await state.session.edit(state.element.id);
      const gate = deferred();
      let operation: Promise<boolean>;
      if (boundary === "source") {
        state.prepare.mockImplementationOnce(async (element) => {
          await gate.promise;
          return activeTextLayout(element);
        });
        state.input().dispatch({ changes: { from: 5, insert: " pending" } });
        operation = state.session.suspendForGeometry();
        await vi.waitFor(() => expect(state.prepare).toHaveBeenCalledOnce());
      } else {
        await state.session.suspendForGeometry();
        vi.mocked(state.renderer.waitForTextElement).mockImplementationOnce(async () => {
          await gate.promise;
        });
        operation = state.session.resumeAfterGeometry();
        await vi.waitFor(() => expect(state.renderer.waitForTextElement).toHaveBeenCalledTimes(3));
      }
      const finishing = state.session.finish();
      state.session.dispose();
      await expect(Promise.all([operation, finishing])).resolves.toEqual([false, false]);
      expect(state.operations()).toBe(0);
      expect(state.session.geometrySuspended).toBe(false);
      expect(state.dispose).toHaveBeenCalledOnce();
      expect(state.hasExportPreparation()).toBe(false);
      gate.release();
      expect(state.history.commandCount).toBe(0);
      expect(state.error).not.toHaveBeenCalled();
    },
  );
});
