// @vitest-environment happy-dom
import { beforeEach, expect, it, vi } from "vitest";
import {
  imageSessionFixture,
  deferredImageSession as deferred,
  sessionImage as image,
} from "../../../../fixtures/obsidian/image-session";
import {
  createActiveEditorModel,
  createHarness,
} from "../../../../fixtures/obsidian/active-controller";
import { FakeEditorToolbarMenu } from "../../../../adapters/obsidian/editor-toolbar-menu";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";

beforeEach(installObsidianDomHelpers);

it("changes only underlay paint, retains source pixels and exactly replays explicit and automatic contrast", async () => {
  const f = imageSessionFixture({}, [image]);
  try {
    const original = f.store.get(image.id)!;
    const prepare = vi.spyOn(f.model, "prepareElementReplacement");
    f.session.setContrast("auto");
    expect(prepare).not.toHaveBeenCalled();
    f.session.setContrast("dark");
    await vi.waitFor(() => expect(f.onCommitted).toHaveBeenCalledOnce());
    const updated = f.store.get(image.id)!;
    expect(updated.element).toEqual({ ...image, contrast: "dark" });
    expect(updated.geometryVersion).toBe(original.geometryVersion);
    expect(updated.paintVersion).toBeGreaterThan(original.paintVersion);
    expect(f.addImageResources).not.toHaveBeenCalled();
    expect(f.history.commandCount).toBe(1);
    expect(f.onCommitted).toHaveBeenCalledWith(true);
    expect(await f.history.undoAsync()).toBe(true);
    expect(f.store.get(image.id)!.element).toEqual(image);
    expect(await f.history.redoAsync()).toBe(true);
    expect(f.session.selectedImageContrast).toBe("dark");
    f.session.setContrast("auto");
    await vi.waitFor(() => expect(f.onCommitted).toHaveBeenCalledTimes(2));
    expect(f.store.get(image.id)!.element).not.toHaveProperty("contrast");
    expect(await f.history.undoAsync()).toBe(true);
    expect(f.session.selectedImageContrast).toBe("dark");
    expect(await f.history.redoAsync()).toBe(true);
    expect(f.session.selectedImageContrast).toBe("auto");
    expect(f.onFailed).not.toHaveBeenCalled();
  } finally {
    f.session.dispose();
  }
});

it.each([
  ["locked", [{ ...image, locked: true }]],
  ["multiple", [image, { ...image, id: "00000000-0000-4000-8000-000000000011" }]],
  ["empty", []],
] as const)("does not offer or mutate an %s image selection", async (_kind, elements) => {
  const f = imageSessionFixture({}, [...elements]);
  try {
    expect(f.session.selectedImageContrast).toBeUndefined();
    f.session.setContrast("light");
    await Promise.resolve();
    expect(f.history.commandCount).toBe(0);
    expect(f.model.revision).toBe(0);
  } finally {
    f.session.dispose();
  }
});

it.each(["selection", "revision", "lock"] as const)(
  "discards an underlay command when %s changes while finishing text",
  async (change) => {
    const gate = deferred<boolean>();
    const finishText = vi.fn(() => gate.promise);
    const f = imageSessionFixture({ finishText }, [image]);
    try {
      f.session.setContrast("light");
      expect(finishText).toHaveBeenCalledOnce();
      if (change === "selection") f.options.select(new Set());
      else if (change === "revision") f.changeRevision();
      else f.store.replaceMany([{ ...image, locked: true }]);
      gate.resolve(true);
      await gate.promise;
      await Promise.resolve();
      expect(f.store.get(image.id)?.element).not.toHaveProperty("contrast");
      expect(f.history.commandCount).toBe(0);
      expect(f.onCommitted).not.toHaveBeenCalled();
    } finally {
      f.session.dispose();
    }
  },
);

it("rechecks the selection after asynchronous replacement preparation", async () => {
  const gate = deferred<void>();
  const f = imageSessionFixture({}, [image]);
  const originalPrepare = f.model.prepareElementReplacement.bind(f.model);
  const prepare = vi
    .spyOn(f.model, "prepareElementReplacement")
    .mockImplementation(async (...args) => {
      await gate.promise;
      return originalPrepare(...args);
    });
  try {
    f.session.setContrast("light");
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledOnce());
    f.options.select(new Set());
    gate.resolve();
    await gate.promise;
    await Promise.resolve();
    expect(f.store.get(image.id)?.element).toEqual(image);
    expect(f.history.commandCount).toBe(0);
  } finally {
    f.session.dispose();
  }
});

it("opens the checked underlay menu from the image context and guards stale choice actions", async () => {
  const f = imageSessionFixture({}, [image]);
  const menus: FakeEditorToolbarMenu[] = [];
  const createMenu = () => {
    const menu = new FakeEditorToolbarMenu();
    menus.push(menu);
    return menu;
  };
  const h = createHarness({
    model: {
      ...createActiveEditorModel(f.store),
      ...f.model,
      get revision() {
        return f.model.revision;
      },
    },
    menuFactory: { create: createMenu, forEvent: createMenu },
  });
  try {
    h.controller.handleToolbarAction("select");
    h.key("a", { ctrlKey: true });
    h.controller.handleContextMenu(new MouseEvent("contextmenu", { cancelable: true }));
    const parent = menus[0]!.entries.find(
      (entry) => entry !== "separator" && entry.title === "Underlay: Auto",
    );
    expect(parent).toBeDefined();
    if (parent === undefined || parent === "separator") throw new Error("Missing underlay action.");
    parent.click?.();
    const choices = menus[1]!.entries.filter((entry) => entry !== "separator");
    expect(choices.map(({ title, checked }) => [title, checked])).toEqual([
      ["Underlay: Auto", true],
      ["Underlay: Light", false],
      ["Underlay: Dark", false],
    ]);
    choices[1]!.click?.();
    await vi.waitFor(() =>
      expect(f.store.get(image.id)?.element).toHaveProperty("contrast", "light"),
    );
    h.controller.handleToolbarAction("undo");
    await vi.waitFor(() => expect(f.store.get(image.id)?.element).not.toHaveProperty("contrast"));
    h.controller.handleToolbarAction("redo");
    await vi.waitFor(() =>
      expect(f.store.get(image.id)?.element).toHaveProperty("contrast", "light"),
    );
    h.key("Escape");
    choices[2]!.click?.();
    await Promise.resolve();
    expect(f.store.get(image.id)?.element).toHaveProperty("contrast", "light");
  } finally {
    h.dispose();
    f.session.dispose();
  }
});
