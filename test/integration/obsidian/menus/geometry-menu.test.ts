// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { ElementStore } from "../../../../src/domain/store/public";
import {
  createHarness,
  createActiveEditorModel,
} from "../../../fixtures/obsidian/active-controller";
import {
  elementReplacementPorts,
  elementMutationPorts,
} from "../../../fixtures/obsidian/element-mutation-ports";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import {
  FakeEditorToolbarMenu,
  menuAction,
  installNativeMenuMeasurementStyles,
} from "../../../adapters/obsidian/editor-toolbar-menu";

beforeEach(() => {
  installObsidianDomHelpers();
  installNativeMenuMeasurementStyles();
  Platform.isPhone = false;
  Platform.isMobile = false;
});
afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const store = new ElementStore();
  let revision = 0;
  const committed = () => {
    revision += 1;
  };
  const model = {
    ...createActiveEditorModel(store),
    ...elementReplacementPorts(store, committed),
    ...elementMutationPorts(store, committed),
    commitElements: (elements: Parameters<ElementStore["create"]>[0]) => {
      store.create(elements);
      committed();
    },
    removeElements: (ids: readonly string[]) => {
      store.remove(ids);
      committed();
    },
    get revision() {
      return revision;
    },
  };
  const harness = createHarness({ model });
  harness.input.dataset.inkbookMotion = "reduced";
  const menu = new FakeEditorToolbarMenu();
  vi.spyOn(harness.menu, "addItem").mockImplementation((configure) => {
    menu.addItem(configure);
    return harness.menu;
  });
  vi.spyOn(harness.menu, "addSeparator").mockReturnValue(harness.menu);
  const trigger = document.body.createEl("button", { text: "Choose shape" });
  const open = (action: "shape-picker" | "overflow") => {
    menu.entries.length = 0;
    harness.controller.handleToolbarAction(action, trigger);
  };
  return {
    ...harness,
    store,
    menu,
    open,
    trigger,
    dispose: () => {
      harness.dispose();
      trigger.remove();
    },
  };
}

async function insert(test: ReturnType<typeof fixture>, label = "Rectangle") {
  test.open("shape-picker");
  menuAction(test.menu, label).click?.();
  test.open("shape-picker");
  menuAction(test.menu, "Insert selected shape").click?.();
  await vi.waitFor(() =>
    expect(document.querySelector('[aria-label="Geometry operation"]')).not.toBeNull(),
  );
  return test.store.idAtRank("content", 0)!;
}

function button(label: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(
    `.inkbook-adaptive-panel button[aria-label="${label}"]`,
  );
  if (element === null) throw new Error(`Missing geometry action ${label}`);
  return element;
}

function operation(label: string): void {
  const select = document.querySelector<HTMLSelectElement>('[aria-label="Geometry operation"]')!;
  const option = [...select.options].find((choice) => choice.textContent === label);
  if (option === undefined) throw new Error(`Missing geometry operation ${label}`);
  select.value = option.value;
  select.dispatchEvent(new Event("change", { bubbles: true }));
}

it.each([
  ["Rectangle", "rectangle"],
  ["Line", "line"],
  ["Coordinate system", "coordinate-system"],
  ["Table", "table"],
] as const)("inserts %s through the menu with one undoable creation", async (label, kind) => {
  const test = fixture();
  try {
    // The harness exposes a 600px-high viewport and embed, both starting at y=0.
    const visibleCenterY = 300 / test.controller.getViewState().zoom;
    const id = await insert(test, label);
    expect(test.store.get(id)!.element.kind).toBe(kind);
    if (kind === "line") {
      expect(test.store.get(id)!.element).toMatchObject({
        start: { y: visibleCenterY },
        end: { y: visibleCenterY },
      });
    }
    expect(test.controller.chromeProps().toolbarState.hasSelection).toBe(true);
    test.controller.handleToolbarAction("undo");
    await vi.waitFor(() => expect(test.store.size).toBe(0));
    expect(document.querySelector('[aria-label="Geometry operation"]')).toBeNull();
    test.controller.handleToolbarAction("redo");
    await vi.waitFor(() => expect(test.store.get(id)!.element.kind).toBe(kind));
  } finally {
    test.dispose();
  }
});

it("moves, resizes and rotates with taps and restores the same geometry with undo and redo", async () => {
  const test = fixture();
  try {
    const id = await insert(test);
    const original = test.store.get(id)!.element;
    if (original.kind !== "rectangle") throw new Error("Expected an inserted rectangle.");
    button("10 document units or degrees").click();
    button("Right").focus();
    const focus = document.activeElement;
    button("Right").click();
    expect(test.store.get(id)!.element).toMatchObject({ x: original.x + 10 });
    expect(document.activeElement).toBe(focus);
    operation("Resize top left");
    button("Left").click();
    expect(test.store.get(id)!.element).toMatchObject({ x: original.x, width: 110 });
    operation("Rotate");
    button("Right").click();
    expect(test.store.get(id)!.element.rotation).toBeCloseTo(10);
    expect(document.querySelector('.inkbook-menu-geometry [role="status"]')?.textContent).toBe(
      "Geometry updated.",
    );
    test.controller.handleToolbarAction("undo");
    await vi.waitFor(() => expect(test.store.get(id)!.element.rotation).toBe(0));
    test.controller.handleToolbarAction("redo");
    await vi.waitFor(() => expect(test.store.get(id)!.element.rotation).toBeCloseTo(10));
    test.trigger.focus();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
    );
    expect(document.querySelector(".inkbook-menu-geometry")).toBeNull();
  } finally {
    test.dispose();
  }
});

it("reopens selection geometry from Overflow and disposes it with its editor", async () => {
  const test = fixture();
  try {
    await insert(test);
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    test.open("overflow");
    menuAction(test.menu, "Edit geometry").click?.();
    await vi.waitFor(() => expect(document.querySelector(".inkbook-menu-geometry")).not.toBeNull());
  } finally {
    test.dispose();
  }
  expect(document.querySelector(".inkbook-menu-geometry")).toBeNull();
});
