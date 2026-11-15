// @vitest-environment happy-dom
import "../../../../../fixtures/obsidian/menu-motion";
import { expect, it, vi } from "vitest";
import type { ActiveEditorControllerOptions } from "../../../../../../src/obsidian/embeds/active-editor/controller-types";
import { ElementStore } from "../../../../../../src/domain/store/public";
import { createOwnedMenuFactory } from "../../../../../../src/obsidian/menus/owned-menu-factory";
import {
  createHarness,
  createActiveEditorModel,
} from "../../../../../fixtures/obsidian/active-controller";
import { imageElement, imageResource } from "../../../../../fixtures/domain/images";
import { rectangle, highlighter } from "../../../../../unit/domain/store/fixtures";
import { immediateWorkScheduler } from "../../../../../fixtures/obsidian/immediate-work-scheduler";
import { installObsidianDomHelpers } from "../../../../../adapters/obsidian/dom";
import {
  elementMutationPorts,
  elementReplacementPorts,
} from "../../../../../fixtures/obsidian/element-mutation-ports";

function openCropMenu(editor: ReturnType<typeof createHarness>): void {
  editor.key("F10", { shiftKey: true });
  const menu = document.querySelector<HTMLElement>('[role="menu"]');
  expect(menu).not.toBeNull();
  menu!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Home", bubbles: true, cancelable: true }),
  );
  expect(document.activeElement?.textContent).toBe("Crop image");
  document.activeElement!.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
  );
}

it("selects an image by keyboard, opens Crop with Shift+F10 and includes images in Select All", async () => {
  installObsidianDomHelpers();
  const image = imageElement();
  const elements = [rectangle(), image, highlighter()];
  const root = document.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "reduced";
  const onCropImage = vi.fn<NonNullable<ActiveEditorControllerOptions["onCropImage"]>>(async () => {
    expect(document.activeElement).toBe(editor.input);
    return undefined;
  });
  const editor = createHarness({
    model: {
      ...createActiveEditorModel(new ElementStore(elements)),
      imageResource: () => imageResource(),
    },
    onCropImage,
    menuFactory: createOwnedMenuFactory({ anchor: root, workScheduler: immediateWorkScheduler() }),
  });
  try {
    editor.input.focus();
    editor.key("Home");
    expect(editor.renderer.setSelectedElements).toHaveBeenLastCalledWith(new Set([image.id]));
    openCropMenu(editor);
    await vi.waitFor(() => expect(onCropImage).toHaveBeenCalledOnce());
    expect(onCropImage.mock.calls[0]?.[0]).toEqual(image);
    expect(document.querySelector('[role="menu"]')).toBeNull();
    editor.input.focus();
    editor.key("a", { ctrlKey: true });
    expect(editor.renderer.setSelectedElements).toHaveBeenLastCalledWith(
      new Set(elements.map(({ id }) => id)),
    );
    editor.key("F10", { shiftKey: true });
    expect(
      [...document.querySelectorAll('[role="menuitem"]')].some(
        (item) => item.textContent === "Crop image",
      ),
    ).toBe(false);
  } finally {
    editor.dispose();
    root.remove();
  }
});

it("commits an inline crop as an undoable image edit", async () => {
  installObsidianDomHelpers();
  const image = imageElement();
  const resource = imageResource();
  const store = new ElementStore([image]);
  let revision = 0;
  const advance = () => {
    revision += 1;
  };
  const model = {
    ...createActiveEditorModel(store),
    get revision() {
      return revision;
    },
    imageResource: () => resource,
    ...elementMutationPorts(store, advance),
    ...elementReplacementPorts(store, advance),
  };
  const root = document.body.createDiv({ cls: "inkbook-root" });
  root.dataset.inkbookMotion = "reduced";
  const lease = { update: vi.fn(), dispose: vi.fn() };
  const planPaste = vi.spyOn(model, "planClipboardPaste");
  const editor = createHarness(
    {
      model,
      menuFactory: createOwnedMenuFactory({
        anchor: root,
        workScheduler: immediateWorkScheduler(),
      }),
    },
    {
      beginImageCrop: (_image, _resource, onCamera) => {
        onCamera({ x: 0, zoom: 1 });
        return lease;
      },
    },
  );
  try {
    editor.input.focus();
    editor.key("Home");
    openCropMenu(editor);
    await vi.waitFor(() => expect(editor.input.inert).toBe(true));
    const handle = document.querySelector<HTMLButtonElement>('[data-edges="left top"]')!;
    expect(handle).not.toBeNull();
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "ArrowRight", shiftKey: true, bubbles: true }),
    );
    editor.key("Delete");
    editor.key("z", { ctrlKey: true });
    editor.paste(["text/plain"], () => "unexpected");
    expect(store.get(image.id)?.element).toEqual(image);
    expect(planPaste).not.toHaveBeenCalled();
    handle.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }),
    );
    await vi.waitFor(() => expect(store.get(image.id)?.element).not.toEqual(image));
    const cropped = store.get(image.id)!.element;
    expect(cropped.kind === "image" && cropped.crop).toEqual({
      x: 10,
      y: 0,
      width: 390,
      height: 200,
    });
    expect(editor.input.inert).toBe(false);
    expect(document.activeElement).toBe(editor.input);
    editor.key("z", { ctrlKey: true });
    await vi.waitFor(() => expect(store.get(image.id)?.element).toEqual(image));
    editor.key("z", { ctrlKey: true, shiftKey: true });
    await vi.waitFor(() => expect(store.get(image.id)?.element).toEqual(cropped));
    expect(resource).toEqual(imageResource());
    expect(lease.dispose).toHaveBeenCalledOnce();
  } finally {
    editor.dispose();
    root.remove();
  }
});
