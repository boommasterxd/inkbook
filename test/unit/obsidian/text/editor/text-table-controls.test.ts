// @vitest-environment happy-dom
import "../../../../fixtures/obsidian/menu-motion";
import type { EditorView } from "@codemirror/view";
import { afterEach, expect, it, vi } from "vitest";
import {
  TextTableControls,
  type TextTableUiPort,
} from "../../../../../src/obsidian/text/editor/text-table-controls";
import { TEXT_PREVIEW_VIEWPORT_EVENT } from "../../../../../src/obsidian/text/editor/text-preview-widget";
import { createTextTableUi } from "../../../../../src/obsidian/embeds/active-editor/text-table-menu";
import { createOwnedMenuFactory } from "../../../../../src/obsidian/menus/owned-menu-factory";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";
import { appendOwnedIframe } from "../../../../fixtures/obsidian/owned-iframe";

function fixture(ownerDocument = document) {
  installObsidianDomHelpers();
  const node = ownerDocument.createElement("div");
  const dom = ownerDocument.createElement("div");
  dom.append(node);
  ownerDocument.body.append(dom);
  document.body.dataset.inkbookMotion = "reduced";
  const read = vi
    .spyOn(node, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(20, 30, 120, 70));
  type Measurement = { read: () => unknown; write: (value: unknown) => void };
  const measurements: Measurement[] = [];
  const view = {
    dom,
    themeClasses: "cm-test-theme",
    requestMeasure: (request: Measurement) => measurements.push(request),
  } as unknown as EditorView;
  const lifetime = new AbortController();
  return { node, dom, read, measurements, view, lifetime };
}

it("keeps table controls outside the clipped input document and projects native anchors once", () => {
  const inner = appendOwnedIframe();
  inner.document.body.dataset.inkbookMotion = "reduced";
  const { node, view, lifetime, measurements, read } = fixture(inner.document);
  const openMenu = vi.fn<TextTableUiPort["openMenu"]>();
  const project = vi.fn((rect: { left: number; right: number; top: number; bottom: number }) => ({
    left: rect.left * 2 + 100,
    right: rect.right * 2 + 100,
    top: rect.top * 3 + 50,
    bottom: rect.bottom * 3 + 50,
  }));
  const controls = new TextTableControls({
    node,
    view,
    signal: lifetime.signal,
    coordinates: {
      drawingDocument: document,
      toDrawingPoint: ({ x, y }) => ({ x: x * 2 + 100, y: y * 3 + 50 }),
      fromDrawingPoint: () => undefined,
      toDrawingRect: project,
    },
    onAction: vi.fn(),
    ui: {
      labels: {
        addRow: "Row",
        addColumn: "Column",
        menu: "Menu",
        source: "Source",
        preview: "Preview",
        cell: "Cell",
      },
      openMenu,
    },
    activeCell: () => undefined,
    shape: () => ({ rows: 2, columns: 2 }),
  });
  node.dispatchEvent(new PointerEvent("pointerenter"));
  const cell = inner.document.createElement("button");
  node.append(cell);
  cell.dispatchEvent(new PointerEvent("pointermove", { bubbles: true, clientX: 80, clientY: 60 }));
  expect(read).not.toHaveBeenCalled();
  expect(measurements).toHaveLength(1);
  const measure = measurements.shift()!;
  measure.write(measure.read());
  const layer = document.querySelector<HTMLElement>(".inkbook-text-table-controls-layer")!;
  expect(layer.ownerDocument).toBe(document);
  expect(inner.document.querySelector(".inkbook-text-table-controls-layer")).toBeNull();
  expect(layer.querySelectorAll("button")[2]!.style.left).toBe("352px");
  expect(read).toHaveBeenCalledOnce();
  expect(project).toHaveBeenCalledTimes(2);
  const root = layer.querySelector<HTMLElement>(".inkbook-text-table-controls")!;
  const menu = layer.querySelector<HTMLButtonElement>(".inkbook-text-table-menu")!;
  node.dispatchEvent(new PointerEvent("pointerleave", { clientX: 130, clientY: 30 }));
  inner.document.dispatchEvent(new PointerEvent("pointermove", { clientX: 130, clientY: 27 }));
  for (let step = 0; step < 20; step++)
    document.dispatchEvent(
      new PointerEvent("pointermove", { clientX: 360, clientY: 130 - step / 2 }),
    );
  expect(root.classList.contains("inkbook-text-table-controls-hidden")).toBe(false);
  menu.click();
  expect(openMenu).toHaveBeenCalledOnce();
  openMenu.mock.lastCall![0].onClose();
  document.dispatchEvent(new PointerEvent("pointermove", { clientX: 1, clientY: 1 }));
  expect(root.classList.contains("inkbook-text-table-controls-hidden")).toBe(true);
  expect(read).toHaveBeenCalledOnce();
  expect(project).toHaveBeenCalledTimes(2);
  controls.dispose();
  inner.frame.remove();
  expect(layer.isConnected).toBe(false);
});

afterEach(() => {
  document.body.replaceChildren();
  delete document.body.dataset.inkbookMotion;
  vi.restoreAllMocks();
});

it("suspends floating controls without measurements and reconciles hover and focus before revealing them", () => {
  const { node, dom, read, measurements, view, lifetime } = fixture();
  const input = document.createElement("textarea");
  node.append(input);
  const action = vi.fn();
  const controls = new TextTableControls({
    node,
    view,
    signal: lifetime.signal,
    onAction: action,
    activeCell: () => undefined,
    shape: () => ({ rows: 2, columns: 2 }),
  });
  const layer = document.querySelector<HTMLElement>(".inkbook-text-table-controls-layer")!;
  const root = layer.querySelector<HTMLElement>(".inkbook-text-table-controls")!;
  node.dispatchEvent(new PointerEvent("pointerenter"));
  const initial = measurements.shift()!;
  initial.write(initial.read());
  expect(read).toHaveBeenCalledOnce();
  controls.setSuspended(true);
  expect(layer.hidden).toBe(true);
  expect(layer.inert).toBe(true);
  node.dispatchEvent(new PointerEvent("pointerleave", { relatedTarget: document.body }));
  for (let index = 0; index < 100; index++)
    dom.dispatchEvent(new Event(TEXT_PREVIEW_VIEWPORT_EVENT));
  layer.querySelector<HTMLButtonElement>(".inkbook-text-table-add-row")!.click();
  expect(action).not.toHaveBeenCalled();
  expect(measurements).toHaveLength(0);
  controls.setSuspended(false);
  expect(root.classList.contains("inkbook-text-table-controls-hidden")).toBe(true);
  expect(root.style.opacity).toBe("0");
  expect(measurements).toHaveLength(0);
  controls.setSuspended(true);
  input.focus();
  expect(layer.hidden).toBe(true);
  expect(measurements).toHaveLength(0);
  controls.setSuspended(false);
  expect(layer.inert).toBe(false);
  expect(layer.hidden).toBe(true);
  expect(measurements).toHaveLength(1);
  const resumed = measurements.shift()!;
  resumed.write(resumed.read());
  expect(layer.hidden).toBe(false);
  expect(root.style.opacity).toBe("1");
  expect(root.classList.contains("inkbook-text-table-controls-hidden")).toBe(false);
  expect(read).toHaveBeenCalledTimes(2);
  expect(document.activeElement).toBe(input);
  controls.setSuspended(true);
  lifetime.abort();
  controls.setSuspended(false);
  expect(layer.isConnected).toBe(false);
});

it("owns one body layer, coalesces visible measurements and removes all work on abort", () => {
  const { node, dom, read, measurements, view, lifetime } = fixture();
  const field = document.createElementNS("http://www.w3.org/2000/svg", "foreignObject");
  dom.replaceChildren(field);
  const boundary = document.createElement("div");
  boundary.className = "inkbook-text-line-boundary";
  const blank = document.createElement("div");
  blank.className = "cm-line";
  const following = document.createElement("div");
  following.textContent = "After table";
  field.append(node, boundary, blank, following);
  const fieldRead = vi
    .spyOn(field, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(10, 20, 160, 220));
  const followingRead = vi
    .spyOn(following, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(20, 105, 120, 20));
  let active = false;
  const action = vi.fn();
  const controls = new TextTableControls({
    node,
    view,
    signal: lifetime.signal,
    onAction: action,
    activeCell: () => (active ? { row: 0, column: 0 } : undefined),
    shape: () => ({ rows: 2, columns: 2 }),
  });
  expect(measurements).toHaveLength(0);
  active = true;
  controls.refresh();
  for (let index = 0; index < 8; index++) dom.dispatchEvent(new Event(TEXT_PREVIEW_VIEWPORT_EVENT));
  expect(measurements).toHaveLength(1);
  const layer = document.body.querySelector<HTMLElement>(".inkbook-text-table-controls-layer")!;
  expect(node.contains(layer)).toBe(false);
  expect(layer.classList.contains("cm-test-theme")).toBe(true);
  expect(layer.querySelectorAll("button")).toHaveLength(3);
  const measure = measurements.shift()!;
  measure.write(measure.read());
  expect(read).toHaveBeenCalledTimes(1);
  expect(fieldRead).toHaveBeenCalledTimes(1);
  expect(followingRead).toHaveBeenCalledTimes(1);
  const add = layer.querySelector<HTMLButtonElement>(".inkbook-text-table-add-row")!;
  expect(add.style.height).toBe("28px");
  expect(add.style.top).toBe("100px");
  add.click();
  expect(action).toHaveBeenCalledWith({ kind: "append-row" });
  dom.dispatchEvent(new Event(TEXT_PREVIEW_VIEWPORT_EVENT));
  expect(measurements).toHaveLength(1);
  lifetime.abort();
  const pending = measurements.shift()!;
  pending.write(pending.read());
  expect(read).toHaveBeenCalledTimes(1);
  expect(fieldRead).toHaveBeenCalledTimes(1);
  expect(followingRead).toHaveBeenCalledTimes(1);
  dom.dispatchEvent(new Event(TEXT_PREVIEW_VIEWPORT_EVENT));
  window.dispatchEvent(new Event("resize"));
  expect(measurements).toHaveLength(0);
  expect(layer.isConnected).toBe(false);
  delete document.body.dataset.inkbookMotion;
});

it("keeps table focus across hover, Escape, menu actions and aborted menu ownership", () => {
  const { node, dom, view, lifetime, measurements } = fixture();
  const input = document.createElement("textarea");
  node.append(input);
  const action = vi.fn();
  const factory = createOwnedMenuFactory({
    anchor: dom,
    workScheduler: workSchedulerFromFrames(window),
  });
  const ui = createTextTableUi({ factory, owner: dom });
  const open = vi.spyOn(ui, "openMenu");
  let active = true;
  const controls = new TextTableControls({
    node,
    view,
    signal: lifetime.signal,
    ui,
    onAction: action,
    activeCell: () => (active ? { row: 1, column: 1 } : undefined),
    shape: () => ({ rows: 3, columns: 2, alignments: ["left", "center"] }),
    layout: () => ({ width: 120, rowTop: (row) => row * 30 }),
  });
  const target = node.querySelector<SVGSVGElement>(".inkbook-text-table-target")!;
  const layer = document.querySelector<HTMLElement>(".inkbook-text-table-controls-layer")!;
  const menu = layer.querySelector<HTMLButtonElement>(".inkbook-text-table-menu")!;
  active = false;
  controls.refresh();
  node.dispatchEvent(new PointerEvent("pointerenter"));
  const pending = measurements.shift()!;
  pending.write(pending.read());
  node.dispatchEvent(new PointerEvent("pointerleave", { relatedTarget: menu }));
  layer.dispatchEvent(new PointerEvent("pointerenter"));
  expect(layer.querySelector(".inkbook-text-table-controls-hidden")).toBeNull();
  input.focus();
  const pointer = new PointerEvent("pointerdown", { bubbles: true, cancelable: true });
  menu.dispatchEvent(pointer);
  expect(pointer.defaultPrevented).toBe(true);
  expect(document.activeElement).toBe(input);
  menu.click();
  menu.click();
  expect(open).toHaveBeenCalledTimes(1);
  expect(menu.getAttribute("aria-expanded")).toBe("true");
  expect(target.hasAttribute("hidden")).toBe(false);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(menu.getAttribute("aria-expanded")).toBe("false");
  expect(target.hasAttribute("hidden")).toBe(true);
  expect(document.activeElement).toBe(input);
  active = false;
  menu.click();
  const items = [...document.querySelectorAll<HTMLButtonElement>(".inkbook-owned-menu-item")];
  expect(
    items
      .find((item) => item.textContent?.includes("Align column center"))
      ?.getAttribute("aria-checked"),
  ).toBe("true");
  items.find((item) => item.textContent?.includes("Insert column right"))!.click();
  expect(action).toHaveBeenLastCalledWith({ kind: "insert-column", column: 2 });
  expect(target.hasAttribute("hidden")).toBe(true);
  expect(document.activeElement).toBe(input);
  active = false;
  input.blur();
  layer.dispatchEvent(new PointerEvent("pointerleave", { relatedTarget: document.body }));
  expect(layer.querySelector(".inkbook-text-table-controls-hidden")).not.toBeNull();
  menu.focus();
  expect(document.activeElement).toBe(menu);
  active = true;
  controls.refresh();
  layer.querySelector<HTMLButtonElement>(".inkbook-text-table-add-column")!.click();
  expect(action).toHaveBeenLastCalledWith({ kind: "insert-column", column: 2 });
  menu.click();
  lifetime.abort();
  expect(document.querySelector(".inkbook-owned-menu")).toBeNull();
  expect(layer.isConnected).toBe(false);
  expect(target.isConnected).toBe(false);
  controls.refresh();
});

it("previews the remembered table cell, row and column targets through the real action menu", () => {
  const { node, dom, view, lifetime } = fixture();
  const factory = createOwnedMenuFactory({
    anchor: dom,
    workScheduler: workSchedulerFromFrames(window),
  });
  const ui = createTextTableUi({ factory, owner: dom });
  let active = true;
  const controls = new TextTableControls({
    node,
    view,
    signal: lifetime.signal,
    ui,
    onAction: vi.fn(),
    activeCell: () => (active ? { row: 1, column: 1 } : undefined),
    shape: () => ({ rows: 3, columns: 2 }),
    layout: () => ({ width: 120, rowTop: (row) => [0, 25, 60, 100][row]! }),
  });
  active = false;
  controls.refresh();
  node.dispatchEvent(new PointerEvent("pointerenter"));
  const menu = document.querySelector<HTMLButtonElement>(".inkbook-text-table-menu")!;
  menu.click();
  const target = node.querySelector<SVGSVGElement>(".inkbook-text-table-target")!;
  const area = target.querySelector("rect")!;
  const edge = target.querySelector("path")!;
  const bounds = () =>
    ["x", "y", "width", "height"].map((attribute) => area.getAttribute(attribute));
  const preview = (title: string) => {
    const item = [...document.querySelectorAll<HTMLElement>("[role=menuitem]")].find(
      (candidate) => candidate.textContent === title,
    )!;
    item.dispatchEvent(new PointerEvent("pointermove", { pointerType: "mouse" }));
  };
  expect(document.querySelector('[data-label="true"]')?.textContent).toBe("Row 2 · Column 2");
  expect(target.hasAttribute("hidden")).toBe(false);
  expect(bounds()).toEqual(["60", "25", "60", "35"]);
  preview("Insert row above");
  expect(bounds()).toEqual(["0", "25", "120", "35"]);
  expect(edge.getAttribute("d")).toBe("M0 25H120");
  preview("Insert row below");
  expect(edge.getAttribute("d")).toBe("M0 60H120");
  preview("Insert column right");
  expect(bounds()).toEqual(["60", "0", "60", "100"]);
  expect(edge.getAttribute("d")).toBe("M120 0V100");
  preview("Align column center");
  expect(bounds()).toEqual(["60", "0", "60", "100"]);
  expect(edge.getAttribute("d")).toBe("");
  preview("Delete row");
  expect(bounds()).toEqual(["0", "25", "120", "35"]);
  expect(target.getAttribute("data-warning")).toBe("true");
  preview("Delete column");
  expect(bounds()).toEqual(["60", "0", "60", "100"]);
  expect(target.getAttribute("data-warning")).toBe("true");
  preview("Edit Markdown source");
  expect(target.hasAttribute("hidden")).toBe(true);
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(target.hasAttribute("hidden")).toBe(true);
  menu.click();
  expect(bounds()).toEqual(["60", "25", "60", "35"]);
  expect(target.hasAttribute("hidden")).toBe(false);
  expect(target.getAttribute("data-warning")).toBe("false");
  lifetime.abort();
  expect(target.isConnected).toBe(false);
  expect(document.querySelector('[role="menu"]')).toBeNull();
});
