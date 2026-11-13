// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";
import { afterEach, expect, it, vi } from "vitest";
import { createTextTableUi } from "../../../../../src/obsidian/embeds/active-editor/text-table-menu";
import { createOwnedMenuFactory } from "../../../../../src/obsidian/menus/owned-menu-factory";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { Localization } from "../../../../../src/domain/localization";

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

it("projects a scaled iframe anchor into the host menu and aborts its lifecycle once", () => {
  installObsidianDomHelpers();
  const owner = document.createElement("div");
  owner.dataset.inkbookMotion = "reduced";
  const frame = document.createElement("iframe");
  document.body.append(owner, frame);
  Object.defineProperty(frame.contentWindow!, "frameElement", { value: frame });
  vi.spyOn(frame, "getBoundingClientRect").mockReturnValue(new DOMRect(100, 200, 400, 300));
  Object.defineProperties(frame, {
    offsetWidth: { value: 200 },
    offsetHeight: { value: 150 },
    clientLeft: { value: 1 },
    clientTop: { value: 2 },
  });
  const anchor = frame.contentDocument!.createElement("button");
  frame.contentDocument!.body.append(anchor);
  vi.spyOn(anchor, "getBoundingClientRect").mockReturnValue(new DOMRect(10, 20, 28, 28));
  const factory = createOwnedMenuFactory({
    anchor: owner,
    workScheduler: workSchedulerFromFrames(window),
  });
  const menu = factory.create("context");
  const create = vi.spyOn(factory, "create").mockReturnValue(menu);
  const placement = vi.spyOn(menu, "showAtPosition");
  const localization = new Localization("de");
  const ui = createTextTableUi({ factory, owner, localization });
  expect(ui.labels.addRow).toBe("Zeile hinzufügen");
  const lifetime = new AbortController();
  const closed = vi.fn();
  const onAction = vi.fn();
  const onPreview = vi.fn();
  const request = {
    anchor,
    row: 2,
    column: 1,
    rows: 4,
    columns: 3,
    signal: lifetime.signal,
    onAction,
    onPreview,
    onClose: closed,
  };
  ui.openMenu(request);
  expect(create).toHaveBeenCalledExactlyOnceWith("context");
  expect(placement).toHaveBeenCalledWith({ x: 122, y: 300, width: 56 }, document);
  const target = document.querySelector('[data-label="true"]')!;
  expect(target.textContent).toBe("Zeile 3 · Spalte 2");
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(onPreview).toHaveBeenLastCalledWith({ kind: "insert-row", row: 2, placement: "before" });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
  expect(onPreview.mock.calls.slice(-2)).toEqual([
    [undefined],
    [{ kind: "insert-row", row: 2, placement: "after" }],
  ]);
  const deleteColumn = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
    (button) => button.textContent?.includes("Spalte löschen"),
  )!;
  deleteColumn.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse" }));
  expect(onPreview).toHaveBeenLastCalledWith({ kind: "delete-column", column: 1 });
  localization.setLanguage("en");
  expect(target.textContent).toBe("Row 3 · Column 2");
  const source = [...document.querySelectorAll<HTMLButtonElement>(".inkbook-owned-menu-item")].find(
    (button) => button.textContent?.includes("Edit Markdown source"),
  )!;
  source.focus();
  expect(onPreview).toHaveBeenLastCalledWith({ kind: "source" });
  source.click();
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ kind: "source" });
  expect(closed).toHaveBeenCalledOnce();
  onPreview.mockClear();
  source.dispatchEvent(new FocusEvent("focus"));
  source.dispatchEvent(new FocusEvent("focusout"));
  expect(onPreview).not.toHaveBeenCalled();
  lifetime.abort();
  ui.openMenu(request);
  expect(create).toHaveBeenCalledTimes(1);
  expect(closed).toHaveBeenCalledTimes(1);
});

it("previews and commits the same target when activating a table column action", () => {
  installObsidianDomHelpers();
  const owner = document.createElement("button");
  owner.dataset.inkbookMotion = "reduced";
  document.body.append(owner);
  const factory = createOwnedMenuFactory({
    anchor: owner,
    workScheduler: workSchedulerFromFrames(window),
  });
  const onPreview = vi.fn();
  const onAction = vi.fn(() => expect(onPreview).toHaveBeenLastCalledWith(undefined));
  createTextTableUi({ factory, owner }).openMenu({
    anchor: owner,
    row: 2,
    column: 1,
    rows: 4,
    columns: 3,
    signal: new AbortController().signal,
    onPreview,
    onAction,
    onClose: vi.fn(),
  });
  const action = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find((button) =>
    button.textContent?.includes("Delete column"),
  )!;
  action.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse" }));
  expect(onPreview).toHaveBeenLastCalledWith({ kind: "delete-column", column: 1 });
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  expect(onAction).toHaveBeenCalledExactlyOnceWith({ kind: "delete-column", column: 1 });
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
