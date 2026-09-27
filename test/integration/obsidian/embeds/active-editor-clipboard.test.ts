import { describe, expect, it, vi } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { ElementStore, type ElementMutation } from "../../../../src/domain/store/public";
import { createDragElement } from "../../../../src/editor/tools/public";
import { type PastePlan } from "../../../../src/persistence/clipboard/public";
import { type EncodedClipboard } from "../../../../src/persistence/clipboard/types";
import { ActiveEditorClipboardController } from "../../../../src/obsidian/embeds/active-editor/controller-clipboard";
import { ActiveEditorActions } from "../../../../src/obsidian/embeds/active-editor/controller-actions";
import { ActiveEditorMenuController } from "../../../../src/obsidian/embeds/active-editor/controller-menu";
import { ActiveEditorHistory } from "../../../../src/obsidian/embeds/active-editor/history";
import { ElementSceneStore } from "../../../../src/obsidian/embeds/active-editor/scene-store";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import type { MenuItemPort, MenuPort } from "../../../../src/obsidian/menus/index";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";
import {
  createClipboardDocumentModel,
  createEncodedClipboardFixture,
  createDeferredPreparation,
  createPastePlan,
  createPreparedToken,
} from "./active-editor-clipboard-fixtures";

class FakeClipboardItem {
  public readonly formats: Record<string, Promise<Blob>>;
  public readonly types: string[];

  public constructor(formats: Record<string, Promise<Blob>>) {
    this.formats = formats;
    this.types = Object.keys(formats);
  }

  public async getType(type: string): Promise<Blob> {
    const value = this.formats[type];
    if (value === undefined) throw new DOMException("Type unavailable", "NotFoundError");
    return value;
  }
}

describe("active editor clipboard bridge", () => {
  it("writes interoperable system text, guards cut versions, and pastes its readback", async () => {
    const selected = rectangle();
    const store = new ElementStore([selected]);
    const encoded = createEncodedClipboardFixture();
    const pastePlan = createPastePlan(selected);
    const cutTransition = appliedMutation("cut");
    const pasteTransition = appliedMutation("paste");
    let pendingMutation: ElementMutation | undefined;
    const prepareElementMutation = vi.fn(async (mutation: ElementMutation) => {
      pendingMutation = mutation;
      return { status: "prepared" as const, token: createPreparedToken() };
    });
    const commitPreparedElementMutation = vi.fn(() => {
      if (pendingMutation?.removeIds !== undefined) return cutTransition;
      if (pendingMutation?.elements !== undefined) return pasteTransition;
      return appliedMutation("history");
    });
    const planClipboardPaste = vi.fn(async () => pastePlan);
    const model = clipboardModel(
      store,
      { commitPreparedElementMutation, planClipboardPaste, prepareElementMutation },
      encoded,
    );
    const writes: FakeClipboardItem[][] = [];
    const ownerWindow = {
      Blob,
      ClipboardItem: FakeClipboardItem,
      navigator: {
        clipboard: {
          read: async () => writes[writes.length - 1] ?? [],
          readText: async () => "",
          write: async (items: FakeClipboardItem[]) => void writes.push(items),
          writeText: vi.fn(async () => undefined),
        },
      },
    } as unknown as Window;
    let selection: ReadonlySet<string> = new Set([selected.id]);
    const onPasteCommitted = vi.fn();
    const history = new ActiveEditorHistory(model);
    const onResult = vi.fn();
    const controller = new ActiveEditorClipboardController({
      currentSelection: () => selection,
      history,
      isPresentationAttached: () => true,
      model,
      onPendingChanged: vi.fn(),
      onPasteCommitted,
      onResult,
      onSelectionChanged: (next) => {
        selection = next;
      },
      ownerWindow,
    });

    await controller.cut(selection);
    expect(writes[0]?.[0]?.types).toEqual(["text/plain"]);
    await expect(writes[0]?.[0]?.getType("text/plain").then((blob) => blob.text())).resolves.toBe(
      encoded.plainText,
    );
    expect(prepareElementMutation.mock.calls[0]?.[0]).toMatchObject({ removeIds: [selected.id] });
    expect(selection.size).toBe(0);
    expect(history.commandCount).toBe(1);
    await expect(history.undoAsync()).resolves.toBe(true);
    expect(pendingMutation).toEqual(cutTransition.reverse);
    await expect(history.redoAsync()).resolves.toBe(true);
    expect(pendingMutation).toEqual(cutTransition.forward);

    await controller.paste({ kind: "toolbar", visibleCanvasCenter: { x: 400, y: 300 } });
    expect(planClipboardPaste).toHaveBeenCalledWith(
      { plainText: encoded.plainText },
      { kind: "toolbar", visibleCanvasCenter: { x: 400, y: 300 } },
      undefined,
    );
    expect(pendingMutation).toMatchObject({
      elements: pastePlan.elements,
    });
    expect(selection).toEqual(new Set(pastePlan.selectedIds));
    expect(onPasteCommitted).toHaveBeenCalledWith("select", {
      kind: "toolbar",
      visibleCanvasCenter: { x: 400, y: 300 },
    });
    expect(history.commandCount).toBe(2);
    await expect(history.undoAsync()).resolves.toBe(true);
    expect(pendingMutation).toEqual(pasteTransition.reverse);
    await expect(history.redoAsync()).resolves.toBe(true);
    expect(pendingMutation).toEqual(pasteTransition.forward);
    expect(commitPreparedElementMutation).toHaveBeenCalledTimes(6);
  });
});

describe("active editor clipboard activation boundary", () => {
  it("does not let a hanging activation-bound write block in-session paste", async () => {
    const selected = rectangle();
    const encoded = createEncodedClipboardFixture();
    const planClipboardPaste = vi.fn(async () => null);
    const model = clipboardModel(
      new ElementStore([selected]),
      {
        commitPreparedElementMutation: vi.fn(() => appliedMutation("copy")),
        planClipboardPaste,
        prepareElementMutation: vi.fn(),
      },
      encoded,
    );
    const ownerWindow = {
      Blob,
      ClipboardItem: FakeClipboardItem,
      navigator: {
        clipboard: {
          read: async () => [],
          readText: async () => "",
          write: () => new Promise<void>(() => undefined),
          writeText: vi.fn(async () => undefined),
        },
      },
    } as unknown as Window;
    const onResult = vi.fn();
    const controller = new ActiveEditorClipboardController({
      currentSelection: () => new Set([selected.id]),
      history: new ActiveEditorHistory(model),
      isPresentationAttached: () => true,
      model,
      onPendingChanged: vi.fn(),
      onResult,
      onSelectionChanged: vi.fn(),
      ownerWindow,
    });

    const copy = controller.copy(new Set([selected.id]));
    await expect(copy).resolves.toMatchObject({ kind: "copied" });
    expect(onResult).toHaveBeenCalledOnce();
    expect(onResult).toHaveBeenCalledWith(expect.objectContaining({ kind: "copied" }));
    await controller.paste({ kind: "toolbar", visibleCanvasCenter: { x: 0, y: 0 } });
    expect(planClipboardPaste).toHaveBeenCalledWith(
      { sessionText: encoded.customText },
      { kind: "toolbar", visibleCanvasCenter: { x: 0, y: 0 } },
      undefined,
    );
  });
});

describe("active editor clipboard races", () => {
  it("exposes one exclusive pending operation and rejects a concurrent clipboard action", async () => {
    const selected = rectangle();
    const pending = createDeferredPreparation();
    const { commit, model, prepare } = deferredClipboardModel(
      selected,
      pending.promise,
      createPastePlan(selected),
      "cut",
    );
    const pendingChanges: boolean[] = [];
    const harness = clipboardHarness(model, selected.id, (value) => pendingChanges.push(value));

    const cut = harness.controller.cut(harness.selection());
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    expect(harness.controller.canCopyOrCut).toBe(false);
    expect(harness.controller.canPaste).toBe(false);
    await expect(
      harness.controller.paste({ kind: "toolbar", visibleCanvasCenter: { x: 0, y: 0 } }),
    ).resolves.toMatchObject({ kind: "unavailable", reason: "busy" });
    pending.complete();
    await expect(cut).resolves.toMatchObject({ action: "cut", kind: "committed" });
    expect(pendingChanges).toEqual([true, false]);
    expect(commit).toHaveBeenCalledTimes(1);
  });

  it("rechecks the exact cut selection after asynchronous preparation", async () => {
    const selected = rectangle();
    const pending = createDeferredPreparation();
    const { commit, model, prepare } = deferredClipboardModel(
      selected,
      pending.promise,
      null,
      "cut",
    );
    const harness = clipboardHarness(model, selected.id, vi.fn());

    const cut = harness.controller.cut(harness.selection());
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    harness.setSelection(new Set());
    pending.complete();

    await expect(cut).resolves.toMatchObject({ kind: "unavailable", reason: "stale-operation" });
    expect(commit).not.toHaveBeenCalled();
    expect(harness.history.commandCount).toBe(0);
  });

  it("rejects a prepared paste after its basis revision becomes stale", async () => {
    const selected = rectangle();
    const pending = createDeferredPreparation();
    let revision = 7;
    const { commit, model, prepare } = deferredClipboardModel(
      selected,
      pending.promise,
      createPastePlan(selected),
      "paste",
      () => revision,
    );
    const harness = clipboardHarness(model, selected.id, vi.fn());

    const paste = harness.controller.paste({
      kind: "toolbar",
      visibleCanvasCenter: { x: 0, y: 0 },
    });
    await vi.waitFor(() => expect(prepare).toHaveBeenCalledTimes(1));
    revision += 1;
    pending.complete();

    await expect(paste).resolves.toMatchObject({ kind: "unavailable", reason: "stale-operation" });
    expect(commit).not.toHaveBeenCalled();
    expect(harness.history.commandCount).toBe(0);
  });
});

describe("active editor arrange and menu bridge", () => {
  it("records arrange as one reversible band-order command and uses the native pointer event", async () => {
    const first = rectangle();
    const second = rectangle("00000000-0000-4000-8000-000000000002", 300);
    const store = new ElementStore([first, second]);
    const initialOrder = store.materializeBandOrder("content");
    const selectedId = initialOrder[0]!;
    const model = clipboardModel(
      store,
      {
        commitPreparedElementMutation: vi.fn(() => null),
        planClipboardPaste: vi.fn(async () => null),
        prepareElementMutation: vi.fn(async () => ({ status: "noop" as const, token: null })),
      },
      createEncodedClipboardFixture(),
    );
    const history = new ActiveEditorHistory(model);
    const sceneStore = new ElementSceneStore(store);
    const stateChanged = vi.fn();
    const unsubscribe = store.subscribe(() => void stateChanged());
    const actions = new ActiveEditorActions({
      renderer: { setElementFade: vi.fn(), clearElementFade: vi.fn() },
      currentSelection: () => new Set([selectedId]),
      history,
      isAttached: () => true,
      isEnabled: () => true,
      model,
      lastSessionPointer: () => null,
      onCopyEmbed: vi.fn(),
      onDeleteEmbed: vi.fn(),
      onPasteCommitted: vi.fn(),
      onPendingChanged: vi.fn(),
      onStateChanged: stateChanged,
      ownerWindow: clipboardWindow(),
      sceneStore,
      setSelection: vi.fn(),
      visibleCenter: () => ({ x: 100, y: 100 }),
    });

    actions.execute("bring-to-front");
    expect(stateChanged).toHaveBeenCalledTimes(1);
    expect(store.materializeBandOrder("content")).toEqual([initialOrder[1], selectedId]);
    expect(history.commandCount).toBe(1);
    await expect(history.undoAsync()).resolves.toBe(true);
    expect(store.materializeBandOrder("content")).toEqual(initialOrder);

    const showAtPosition = vi.fn();
    const menu = fakeMenu(showAtPosition);
    const event = { clientX: 20, clientY: 30 } as MouseEvent;
    const factory = { create: vi.fn(() => menu), forEvent: vi.fn(() => menu) };
    const menus = new ActiveEditorMenuController({
      workScheduler: immediateWorkScheduler(),
      actions,
      factory,
      inputSurface: { focus: vi.fn() } as unknown as HTMLDivElement,
      ownerDocument: {} as Document,
      selectionSize: () => 1,
      storeSize: () => store.size,
      toScreenPoint: (point) => point,
      visibleSelectionCenter: () => ({ x: 120, y: 140 }),
    });
    menus.dispatchFromEvent(event, () => menus.openFromSource("pointer", { x: 20, y: 30 }));
    await vi.waitFor(() => expect(factory.forEvent).toHaveBeenCalledWith(event));
    expect(factory.create).not.toHaveBeenCalled();
    expect(showAtPosition).not.toHaveBeenCalled();

    menus.openFromSource("keyboard", { x: 10, y: 20 });
    await vi.waitFor(() => expect(factory.create).toHaveBeenCalledTimes(1));
    expect(showAtPosition).toHaveBeenCalledWith({ x: 120, y: 140 }, expect.anything());
    unsubscribe();
    menus.dispose();
    actions.dispose();
  });
});

function clipboardModel(
  store: ElementStore,
  ports: Pick<
    EditableDocumentModel,
    "commitPreparedElementMutation" | "planClipboardPaste" | "prepareElementMutation"
  >,
  encoded: EncodedClipboard,
  revision: () => number = () => 7,
): EditableDocumentModel {
  return createClipboardDocumentModel({
    store,
    commitBandOrder: (order) => void store.reorderBands(order),
    commitPreparedElementMutation: ports.commitPreparedElementMutation,
    encodeClipboard: vi.fn(async () => encoded),
    planClipboardPaste: ports.planClipboardPaste,
    prepareElementMutation: ports.prepareElementMutation,
    revision,
  });
}

function deferredClipboardModel(
  selected: InkElementV1,
  preparation: ReturnType<typeof createDeferredPreparation>["promise"],
  pastePlan: PastePlan | null,
  transitionId: string,
  revision?: () => number,
): {
  readonly commit: ReturnType<typeof vi.fn>;
  readonly model: EditableDocumentModel;
  readonly prepare: ReturnType<typeof vi.fn>;
} {
  const commit = vi.fn(() => appliedMutation(transitionId));
  const prepare = vi.fn(() => preparation);
  const model = clipboardModel(
    new ElementStore([selected]),
    {
      commitPreparedElementMutation: commit,
      planClipboardPaste: vi.fn(async () => pastePlan),
      prepareElementMutation: prepare,
    },
    createEncodedClipboardFixture(),
    revision,
  );
  return { commit, model, prepare };
}

function clipboardHarness(
  model: EditableDocumentModel,
  selectedId: string,
  onPendingChanged: (pending: boolean) => void,
): {
  readonly controller: ActiveEditorClipboardController;
  readonly history: ActiveEditorHistory;
  selection(): ReadonlySet<string>;
  setSelection(selection: ReadonlySet<string>): void;
} {
  let selection: ReadonlySet<string> = new Set([selectedId]);
  const history = new ActiveEditorHistory(model);
  const controller = new ActiveEditorClipboardController({
    currentSelection: () => selection,
    history,
    isPresentationAttached: () => true,
    model,
    onPendingChanged,
    onPasteCommitted: vi.fn(),
    onResult: vi.fn(),
    onSelectionChanged: (next) => {
      selection = next;
    },
    ownerWindow: clipboardWindow(),
  });
  return {
    controller,
    history,
    selection: () => selection,
    setSelection: (next) => {
      selection = next;
    },
  };
}

function appliedMutation(
  id: string,
): import("../../../../src/domain/store/public").AppliedElementMutation {
  return {
    forward: { bands: { content: [id], highlight: [] } },
    payloadBytes: 1,
    reverse: { bands: { content: [], highlight: [id] } },
  };
}

function rectangle(id = "00000000-0000-4000-8000-000000000001", offset = 0): InkElementV1 {
  return createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 200 + offset, y: 200 },
    identity: { createdAt: 1, id },
    start: { x: 100 + offset, y: 100 },
    tool: "rectangle",
  });
}

function clipboardWindow(): Window {
  return {
    Blob,
    ClipboardItem: FakeClipboardItem,
    confirm: () => true,
    navigator: {
      clipboard: {
        read: async () => [],
        readText: async () => "",
        write: async () => undefined,
        writeText: async () => undefined,
      },
    },
  } as unknown as Window;
}

function fakeMenu(
  showAtPosition: (
    position: Parameters<MenuPort["showAtPosition"]>[0],
    ownerDocument: Document,
  ) => unknown,
): MenuPort {
  const item = {} as MenuItemPort;
  item.setTitle = vi.fn(() => item);
  item.setIcon = vi.fn(() => item);
  item.setDisabled = vi.fn(() => item);
  item.setWarning = vi.fn(() => item);
  item.setIsLabel = vi.fn(() => item);
  item.onClick = vi.fn(() => item);
  const port: MenuPort = {
    addItem: (configure) => {
      configure(item);
      return port;
    },
    addSeparator: () => port,
    close: vi.fn(),
    onHide: vi.fn(),
    showAtPosition: (position, ownerDocument) => {
      showAtPosition(position, ownerDocument);
      return port;
    },
  };
  return port;
}
