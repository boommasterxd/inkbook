// @vitest-environment happy-dom
import { expect, it, vi } from "vitest";
import { ElementStore } from "../../../../../src/domain/store/public";
import type {
  ImageCropV3,
  ImageElementV3,
  ImageResourceV3,
} from "../../../../../src/domain/schema/public";
import {
  ActiveImageSession,
  type ActiveImageSessionOptions,
} from "../../../../../src/obsidian/embeds/active-editor/image-session";
import { ActiveEditorHistory } from "../../../../../src/obsidian/embeds/active-editor/history";
import type { ImportedImageBatch } from "../../../../../src/obsidian/embeds/active-scene/editor-chrome-openings";
import type { EditableDocumentModel } from "../../../../../src/obsidian/embeds/document-session/document-model-port";
import {
  elementMutationPorts,
  elementReplacementPorts,
} from "../../../../fixtures/obsidian/element-mutation-ports";
import { imageElement, imageResource } from "../../../../fixtures/domain/images";
import { PAGE } from "../../../../unit/domain/store/fixtures";
import {
  createActiveEditorModel,
  createHarness,
} from "../../../../fixtures/obsidian/active-controller";
import { installObsidianDomHelpers } from "../../../../adapters/obsidian/dom";
import { applyImageCrop } from "../../../../../src/domain/images/image-crop";
import { SvgSceneRenderer } from "../../../../../src/rendering/scene/scene-renderer";
import { ElementSceneStore } from "../../../../../src/obsidian/embeds/active-editor/scene-store";
import { FakeScheduler } from "../../../../unit/rendering/scene/fakes";
import { sceneDeltaEntries } from "../../../../fixtures/rendering/scene";
import { useImageSceneCleanup } from "../../../../fixtures/rendering/image-scene";

const ownScene = useImageSceneCleanup();

const resource: ImageResourceV3 = { ...imageResource(), width: 4000, height: 1000 };
const image: ImageElementV3 = {
  ...imageElement(),
  x: 24.3,
  y: 24.3,
  width: 400,
  height: 100,
  pivot: { x: 224.3, y: 74.3 },
  crop: { x: 0, y: 0, width: 4000, height: 1000 },
};

function harness(
  overrides: Partial<ActiveImageSessionOptions> = {},
  initial: ImageElementV3[] = [],
) {
  const store = new ElementStore(initial);
  let revision = 0;
  const committed = () => {
    revision += 1;
  };
  let selection: ReadonlySet<string> = new Set(initial.map(({ id }) => id));
  const addImageResources = vi.fn(async () => undefined);
  const model = {
    store,
    page: PAGE,
    get revision() {
      return revision;
    },
    imageResource: () => resource,
    addImageResources,
    ...elementMutationPorts(store, committed),
    ...elementReplacementPorts(store, committed),
  } as unknown as EditableDocumentModel;
  const history = new ActiveEditorHistory(model);
  const onCommitted = vi.fn();
  const onFailed = vi.fn();
  const options: ActiveImageSessionOptions = {
    model,
    history,
    ownerWindow: window,
    isEnabled: () => true,
    finishText: async () => true,
    selection: () => selection,
    select: (next) => {
      selection = next;
    },
    visibleCenter: () => ({ x: 2000, y: 300 }),
    onImportImages: async () => ({
      resources: [resource, { ...resource, id: "b".repeat(64), width: 100, height: 100 }],
      source: "pdf",
    }),
    onCropImage: async () => ({ x: 1000, y: 250, width: 2000, height: 500 }),
    onCommitted,
    onFailed,
    ...overrides,
  };
  const session = new ActiveImageSession(options);
  return {
    session,
    store,
    history,
    model,
    addImageResources,
    options,
    onCommitted,
    onFailed,
    changeRevision: committed,
    selection: () => selection,
  };
}

async function assertReversibleImport(
  owner: ReturnType<typeof harness>,
  elements: readonly ImageElementV3[],
) {
  expect(owner.history.commandCount).toBe(1);
  expect(await owner.history.undoAsync()).toBe(true);
  expect(owner.store.size).toBe(0);
  expect(await owner.history.redoAsync()).toBe(true);
  expect(owner.store.size).toBe(elements.length);
  for (const element of elements) expect(owner.store.get(element.id)!.element).toEqual(element);
  expect(owner.onFailed).not.toHaveBeenCalled();
}

it("cancels a toolbar import when the active editor is disabled", async () => {
  installObsidianDomHelpers();
  const imported = deferred<ImportedImageBatch | undefined>();
  let signal: AbortSignal | undefined;
  const onImportImages = vi.fn((current: AbortSignal) => {
    signal = current;
    return imported.promise;
  });
  const addImageResources = vi.fn(async () => undefined);
  const model = { ...createActiveEditorModel(new ElementStore()), addImageResources };
  const editor = createHarness({ model, onImportImages });
  try {
    editor.controller.handleToolbarAction("image");
    await vi.waitFor(() => expect(onImportImages).toHaveBeenCalledOnce());
    editor.controller.setEnabled(false);
    expect(signal?.aborted).toBe(true);
    imported.resolve({ resources: [resource], source: "image" });
    await imported.promise;
    await Promise.resolve();
    expect(addImageResources).not.toHaveBeenCalled();
    expect(model.store.size).toBe(0);
  } finally {
    editor.dispose();
  }
});
it("imports PDF pages as a bounded vertical sequence and one reversible command", async () => {
  const owner = harness();
  owner.session.import();
  await vi.waitFor(() => expect(owner.onCommitted).toHaveBeenCalledOnce());
  const elements = [...owner.selection()].map(
    (id) => owner.store.get(id)!.element as ImageElementV3,
  );
  expect(elements).toHaveLength(2);
  expect(elements[0]).toMatchObject({ x: 24.3, y: 50, width: 2000, height: 500 });
  expect(elements[1]).toMatchObject({ x: 1924.3, y: 574.3, width: 100, height: 100 });
  expect(owner.addImageResources).toHaveBeenCalledOnce();
  await assertReversibleImport(owner, elements);
  owner.session.dispose();
});

it("imports an image compactly with its full crop and preserves placement through undo and redo", async () => {
  const owner = harness({
    onImportImages: async () => ({ resources: [resource], source: "image" }),
  });
  owner.session.import();
  await vi.waitFor(() => expect(owner.onCommitted).toHaveBeenCalledOnce());
  const id = [...owner.selection()][0]!;
  const inserted = owner.store.get(id)!.element as ImageElementV3;
  expect(inserted).toMatchObject({
    assetId: resource.id,
    x: 1224.3,
    y: 200,
    width: 800,
    height: 200,
    pivot: { x: 1624.3, y: 300 },
    crop: { x: 0, y: 0, width: 4000, height: 1000 },
  });
  expect(owner.addImageResources).toHaveBeenCalledExactlyOnceWith([resource]);
  await assertReversibleImport(owner, [inserted]);
  owner.session.dispose();
});

it("keeps a single PDF page at the existing writing-width placement", async () => {
  const owner = harness({
    onImportImages: async () => ({ resources: [resource], source: "pdf" }),
  });
  owner.session.import();
  await vi.waitFor(() => expect(owner.onCommitted).toHaveBeenCalledOnce());
  const id = [...owner.selection()][0]!;
  expect(owner.store.get(id)!.element).toMatchObject({
    x: 24.3,
    y: 50,
    width: 2000,
    height: 500,
    crop: { x: 0, y: 0, width: 4000, height: 1000 },
  });
  owner.session.dispose();
});

it.each(["image", "pdf"] as const)(
  "inserts a %s underlay at full writing width, locked and deselected, as one reversible batch",
  async (source) => {
    const resources =
      source === "pdf"
        ? [resource, { ...resource, id: "b".repeat(64), width: 100, height: 200 }]
        : [{ ...resource, width: 100, height: 200 }];
    const owner = harness({
      onImportImages: async () => ({ resources, source, placement: "page-width-locked" }),
    });
    owner.session.import({ x: 700, y: 300 });
    await vi.waitFor(() => expect(owner.onCommitted).toHaveBeenCalledOnce());
    expect(owner.onCommitted).toHaveBeenCalledWith(true);
    const elements = owner.store
      .materializeBandOrder("image")
      .map((id) => owner.store.get(id)!.element as ImageElementV3);
    expect(elements).toHaveLength(resources.length);
    for (const [index, element] of elements.entries()) {
      expect(element).toMatchObject({
        x: PAGE.margin,
        width: PAGE.innerWidth,
        height: (PAGE.innerWidth * resources[index]!.height) / resources[index]!.width,
        locked: true,
        crop: { x: 0, y: 0, width: resources[index]!.width, height: resources[index]!.height },
      });
      if (index > 0)
        expect(element.y).toBeCloseTo(
          elements[index - 1]!.y + elements[index - 1]!.height + PAGE.margin,
          3,
        );
    }
    expect(owner.selection().size).toBe(0);
    expect(owner.addImageResources).toHaveBeenCalledExactlyOnceWith(resources);
    await assertReversibleImport(owner, elements);
    owner.session.dispose();
  },
);

it.each(["default", "page-width-locked"] as const)(
  "keeps drawing available after importing an underlay, placement=%s",
  async (placement) => {
    installObsidianDomHelpers();
    const owner = harness();
    const model = {
      ...createActiveEditorModel(owner.store),
      ...owner.model,
      get revision() {
        return owner.model.revision;
      },
    };
    const editor = createHarness({
      model,
      onImportImages: async () => ({ resources: [resource], source: "image", placement }),
    });
    try {
      editor.controller.handleToolbarAction("image");
      await vi.waitFor(() => expect(owner.store.size).toBe(1));
      expect(editor.controller.toolbarState().activeTool).toBe(
        placement === "page-width-locked" ? "draw" : "select",
      );
      expect(editor.controller.toolbarState().hasSelection).toBe(placement === "default");
    } finally {
      editor.dispose();
      owner.session.dispose();
    }
  },
);

it("keeps a locked image selectable without starting crop controls", async () => {
  const onCropImage = vi.fn(async () => image.crop);
  const lockedImage = { ...image, locked: true };
  const owner = harness({ onCropImage }, [lockedImage]);
  expect(owner.session.selectedImageId).toBe(image.id);
  expect(owner.session.canCrop).toBe(false);
  owner.session.crop();
  await Promise.resolve();
  expect(onCropImage).not.toHaveBeenCalled();
  expect(owner.store.get(image.id)?.element).toEqual(lockedImage);
  expect(owner.history.commandCount).toBe(0);
  owner.session.dispose();
});

it("commits a crop through prepared replacement with one undo and reusable original pixels", async () => {
  const owner = harness({}, [image]);
  expect(owner.session.canCrop).toBe(true);
  owner.session.crop();
  await vi.waitFor(() => expect(owner.onCommitted).toHaveBeenCalledOnce());
  expect(owner.store.get(image.id)?.element).toMatchObject({
    crop: { x: 1000, y: 250, width: 2000, height: 500 },
    assetId: resource.id,
    width: 200,
    height: 50,
    x: 124.3,
    y: 49.3,
  });
  expect(owner.history.commandCount).toBe(1);
  expect(await owner.history.undoAsync()).toBe(true);
  expect(owner.store.get(image.id)?.element).toEqual(image);
  expect(await owner.history.redoAsync()).toBe(true);
  expect(owner.store.get(image.id)?.element).toMatchObject({ width: 200, height: 50 });
  expect(owner.addImageResources).not.toHaveBeenCalled();
  owner.session.dispose();
});

it("discards cancelled drafts and stale crop results without replacing later edits", async () => {
  const crop = deferred<ImageCropV3 | undefined>();
  const onCropImage = vi.fn(() => crop.promise);
  const owner = harness({ onCropImage }, [image]);
  owner.session.crop();
  await vi.waitFor(() => expect(onCropImage).toHaveBeenCalledOnce());
  const lockedImage = { ...image, locked: true };
  owner.store.replaceMany([lockedImage]);
  owner.changeRevision();
  crop.resolve({ x: 1, y: 1, width: 100, height: 100 });
  await crop.promise;
  await Promise.resolve();
  expect(owner.store.get(image.id)?.element).toEqual(lockedImage);
  expect(owner.history.commandCount).toBe(0);
  owner.session.dispose();
});

function renderedCropHarness(failPreparation = false) {
  let scene: SvgSceneRenderer;
  const crop = { x: 1000, y: 250, width: 2000, height: 500 };
  const owner = harness(
    {
      renderer: {
        beginPreviewCommit: () => scene.beginPreviewCommit(),
        clearElementPreviews: () => scene.clearElementPreviews(),
      },
      onCropImage: async () => {
        scene.setElementPreviews([applyImageCrop(image, crop)], 1);
        scene.flushPointerFeedbackFrame();
        return crop;
      },
    },
    [image],
  );
  const scheduler = new FakeScheduler();
  const sceneStore = new ElementSceneStore(owner.store);
  const container = document.createElement("div");
  document.body.append(container);
  scene = ownScene(
    new SvgSceneRenderer({
      container,
      page: PAGE,
      store: sceneStore,
      imageResource: () => resource,
      workScheduler: scheduler.workScheduler,
      reducedMotion: true,
      layout: { readViewport: () => ({ left: 0, top: 0, width: 1024, height: 500 }) },
    }),
  );
  const unsubscribe = owner.store.subscribe((delta) =>
    scene.applyDelta({ affected: sceneDeltaEntries(delta) }),
  );
  scheduler.runAll();
  const viewport = scene.svg.querySelector(`[data-element-id="${image.id}"] svg`)!;
  const gate = deferred<void>();
  const prepare = owner.model.prepareElementReplacement.bind(owner.model);
  const preparing = vi
    .spyOn(owner.model, "prepareElementReplacement")
    .mockImplementation(async (...args) => {
      await gate.promise;
      if (failPreparation) throw new Error("Document preparation failed.");
      return prepare(...args);
    });
  return {
    owner,
    scene,
    scheduler,
    viewport,
    gate,
    preparing,
    dispose: () => {
      owner.session.dispose();
      unsubscribe();
      sceneStore.release();
    },
  };
}

it("keeps the confirmed pixels on the retained image throughout delayed preparation and scene commit", async () => {
  const fixture = renderedCropHarness();
  try {
    fixture.owner.session.crop();
    await vi.waitFor(() => expect(fixture.preparing).toHaveBeenCalledOnce());
    expect(fixture.owner.store.get(image.id)?.element).toEqual(image);
    fixture.scheduler.runAll();
    expect(fixture.viewport.getAttribute("viewBox")).toBe("1000 250 2000 500");
    fixture.gate.resolve();
    await vi.waitFor(() => expect(fixture.owner.onCommitted).toHaveBeenCalledOnce());
    expect(fixture.viewport.getAttribute("viewBox")).toBe("1000 250 2000 500");
    fixture.scheduler.runAll();
    expect(fixture.scene.svg.querySelector(`[data-element-id="${image.id}"] svg`)).toBe(
      fixture.viewport,
    );
    expect(fixture.viewport.getAttribute("viewBox")).toBe("1000 250 2000 500");
    expect(fixture.owner.history.commandCount).toBe(1);
  } finally {
    fixture.dispose();
  }
});

it.each(["cancel", "prepare failure"])(
  "clears confirmed pixel feedback on %s without a document command",
  async (failure) => {
    const fixture = renderedCropHarness(failure === "prepare failure");
    try {
      fixture.owner.session.crop();
      await vi.waitFor(() => expect(fixture.preparing).toHaveBeenCalledOnce());
      expect(fixture.viewport.getAttribute("viewBox")).toBe("1000 250 2000 500");
      if (failure === "cancel") {
        fixture.owner.session.cancel();
        fixture.scene.flushPointerFeedbackFrame();
        expect(fixture.viewport.getAttribute("viewBox")).toBe("0 0 4000 1000");
      }
      fixture.gate.resolve();
      await fixture.gate.promise;
      await vi.waitFor(() => {
        fixture.scheduler.runAll();
        expect(fixture.viewport.getAttribute("viewBox")).toBe("0 0 4000 1000");
      });
      expect(fixture.owner.history.commandCount).toBe(0);
      expect(fixture.owner.store.get(image.id)?.element).toEqual(image);
      expect(fixture.owner.onFailed).toHaveBeenCalledTimes(failure === "cancel" ? 0 : 1);
    } finally {
      fixture.dispose();
    }
  },
);

it("releases unchanged crop feedback without preparing a document or adding history", async () => {
  const cancel = vi.fn();
  const clearElementPreviews = vi.fn();
  const owner = harness(
    {
      onCropImage: async () => image.crop,
      renderer: {
        beginPreviewCommit: () => ({ arm: vi.fn(() => true), cancel }),
        clearElementPreviews,
      },
    },
    [image],
  );
  const prepare = vi.spyOn(owner.model, "prepareElementReplacement");
  owner.session.crop();
  await vi.waitFor(() => expect(cancel).toHaveBeenCalledOnce());
  expect(clearElementPreviews).toHaveBeenCalledOnce();
  expect(prepare).not.toHaveBeenCalled();
  expect(owner.history.commandCount).toBe(0);
  owner.session.dispose();
});

it("aborts the owning dialog on disable/dispose and admits no late resource result", async () => {
  const imported = deferred<ImportedImageBatch | undefined>();
  let signal: AbortSignal | undefined;
  const onImportImages = vi.fn((current: AbortSignal) => {
    signal = current;
    return imported.promise;
  });
  const owner = harness({ onImportImages });
  owner.session.import();
  owner.session.import();
  await vi.waitFor(() => expect(onImportImages).toHaveBeenCalledOnce());
  owner.session.cancel();
  expect(signal?.aborted).toBe(true);
  imported.resolve({ resources: [resource], source: "image" });
  await imported.promise;
  await Promise.resolve();
  expect(owner.addImageResources).not.toHaveBeenCalled();
  expect(owner.history.commandCount).toBe(0);
  owner.session.dispose();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
