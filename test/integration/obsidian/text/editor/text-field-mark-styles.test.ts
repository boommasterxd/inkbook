// @vitest-environment happy-dom
import { expect, it } from "vitest";
import { useActiveTextSessions } from "../../../../fixtures/obsidian/active-text-session";
import { textElement } from "../../../../unit/domain/schema/fixtures";
import type { TextElementV2 } from "../../../../../src/domain/schema/public";

const mount = useActiveTextSessions();

async function selectWord(element: TextElementV2, start: number, end: number) {
  const state = mount(element);
  await state.session.edit(element.id);
  const input = state.input();
  input.contentDOM.blur();
  input.dispatch({ selection: { anchor: start, head: end } });
  return state;
}

it("keeps Auto text theme-bound while an explicitly black word remains fixed", async () => {
  const element = textElement();
  element.source = "Auto fixed";
  element.style = { ...element.style, color: { type: "theme-text" } };
  const state = await selectWord(element, 5, 10);
  const input = state.input();
  expect(state.session.applyStyle("color", "#000000FF")).toBe(true);
  await state.session.flush();
  const saved = state.model.store.get(element.id)!.element as TextElementV2;
  expect(saved.style.color).toEqual({ type: "theme-text" });
  expect(saved.ranges).toEqual([
    { start: 5, end: 10, style: { color: { type: "rgba", value: "#000000FF" } } },
  ]);
  const documentState = input.state;
  for (const color of ["#DADADAFF", "#222222FF"]) {
    state.container.style.setProperty("--inkbook-text", color);
    expect(getComputedStyle(input.contentDOM).color).toBe(color);
    const fixed = [...input.contentDOM.querySelectorAll<HTMLElement>(".inkbook-text-run")].find(
      (node) => node.textContent === "fixed",
    );
    expect(fixed).toBeDefined();
    expect(getComputedStyle(fixed!).color).toBe("#000000FF");
    expect(input.state).toBe(documentState);
  }
  expect(state.session.applyStyle("color", "theme-text")).toBe(true);
  await state.session.flush();
  expect((state.model.store.get(element.id)!.element as TextElementV2).ranges).toEqual([
    { start: 5, end: 10, style: { color: { type: "theme-text" } } },
  ]);
  state.container.style.setProperty("--inkbook-text", "#DADADAFF");
  const restored = [...input.contentDOM.querySelectorAll<HTMLElement>(".inkbook-text-run")].find(
    (node) => node.textContent?.includes("fixed"),
  );
  expect(restored).toBeDefined();
  expect(getComputedStyle(restored!).color).toBe("#DADADAFF");
  expect(state.error).not.toHaveBeenCalled();
});

it.each(["bold", "italic", "strikethrough"] as const)(
  "turns off a base %s style only inside the selected word",
  async (mark) => {
    const element = { ...textElement(), source: "Word tail" };
    element.style = { ...element.style, [mark]: true };
    const state = await selectWord(element, 0, 4);
    const input = state.input();
    expect(state.session.applyStyle(`text-${mark}`, false)).toBe(true);
    await state.session.flush();
    expect(state.session.styleSummary()!.style[mark]).toBe(false);
    input.dispatch({ selection: { anchor: 7 } });
    expect(state.session.styleSummary()!.style[mark]).toBe(true);
    expect(state.model.store.get(element.id)?.element).toMatchObject({
      source: "Word tail",
      style: { [mark]: true },
      ranges: [{ start: 0, end: 4, style: { [mark]: false } }],
    });
    expect(state.error).not.toHaveBeenCalled();
  },
);

it.each([
  { source: "Word tail", start: 0, end: 4, rich: true, desired: false },
  { source: "**Word** tail", start: 2, end: 6, rich: false, desired: true },
  { source: "## Word", start: 3, end: 7, rich: undefined, desired: false },
])(
  "resolves a rich or heading conflict for $source without deleting heading syntax",
  async ({ source, start, end, rich, desired }) => {
    const element: TextElementV2 = {
      ...textElement(),
      source,
      ranges: rich === undefined ? [] : [{ start, end, style: { bold: rich } }],
    };
    const state = await selectWord(element, start, end);
    expect(state.session.applyStyle("text-bold", desired)).toBe(true);
    await state.session.flush();
    expect(state.session.styleSummary()!.style.bold).toBe(desired);
    const saved = state.model.store.get(element.id)!.element as TextElementV2;
    if (source.startsWith("##")) expect(saved.source).toBe(source);
    else expect(saved.ranges).toEqual([]);
    expect(state.error).not.toHaveBeenCalled();
  },
);
