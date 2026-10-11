import { vi } from "vitest";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { createDragElement } from "../../../../src/editor/tools/public";

import { type PastePlan } from "../../../../src/persistence/clipboard/public";
import { type EncodedClipboard } from "../../../../src/persistence/clipboard/types";
import type { PreparedElementMutation } from "../../../../src/domain/store/public";
import type { InkElementV1, PageV1 } from "../../../../src/domain/schema/public";
import type { EditableDocumentModel } from "../../../../src/obsidian/embeds/vault-document-session";
import { renderBandOf } from "../../../../src/domain/commands/render-bands";

export function createEncodedClipboardFixture(): EncodedClipboard {
  const customText = 'INKBOOK/1:{"format":"inkbook-elements"}';
  return {
    byteLength: customText.length,
    compactJson: "{}",
    customText,
    fingerprint: "fixture",
    payload: { elements: [], format: "inkbook-elements", version: 1 },
    plainText: customText,
  };
}

function createClipboardPage(): PageV1 {
  return {
    activeBufferLines: 3,
    background: { type: "none" },
    innerWidth: 2_000,
    lockedBufferLines: 1,
    margin: 24.3,
  };
}

export function createClipboardModelDefaults() {
  return {
    commitPreparedElementReplacement: vi.fn(() => "noop" as const),
    prepareElementReplacement: vi.fn(async () => ({ status: "noop" as const, token: null })),
    removeElements: vi.fn(),
    replaceElements: vi.fn(),
    setGestureActive: vi.fn(),
  };
}

export function createClipboardDocumentModel(options: {
  readonly commitBandOrder?: EditableDocumentModel["commitBandOrder"];
  readonly commitPreparedElementMutation: EditableDocumentModel["commitPreparedElementMutation"];
  readonly encodeClipboard?: EditableDocumentModel["encodeClipboard"];
  readonly planClipboardPaste: EditableDocumentModel["planClipboardPaste"];
  readonly prepareElementMutation: EditableDocumentModel["prepareElementMutation"];
  readonly prepareElementRemoval?: EditableDocumentModel["prepareElementRemoval"];
  readonly prepareElementAppend?: EditableDocumentModel["prepareElementAppend"];
  readonly revision?: () => number;
  readonly store: EditableDocumentModel["store"];
}): EditableDocumentModel {
  return {
    mutationAvailability: "available",
    page: createClipboardPage(),
    get revision() {
      return options.revision?.() ?? 7;
    },
    store: options.store,
    arrangeElements: vi.fn(),
    commitBandOrder: options.commitBandOrder ?? vi.fn(),
    commitElement: vi.fn(),
    commitElements: vi.fn(),
    commitPage: vi.fn(),
    commitPreparedElementMutation: options.commitPreparedElementMutation,
    ...createClipboardModelDefaults(),
    encodeClipboard: options.encodeClipboard ?? vi.fn(async () => null),
    planClipboardPaste: options.planClipboardPaste,
    prepareElementMutation: options.prepareElementMutation,
    prepareElementArrangement: (action, selection, cancellation) =>
      options.store.prepareElementArrangement(action, selection, {
        isCancelled: () => cancellation.isCancelled(),
        shouldYield: () => false,
        yieldControl: () => Promise.resolve(),
      }),
    prepareElementAppend:
      options.prepareElementAppend ??
      ((elements, cancellation) =>
        options.prepareElementMutation(
          {
            bands: {
              content: [
                ...options.store.materializeBandOrder("content"),
                ...elements
                  .filter((element) => renderBandOf(element) === "content")
                  .map(({ id }) => id),
              ],
              highlight: [
                ...options.store.materializeBandOrder("highlight"),
                ...elements
                  .filter((element) => renderBandOf(element) === "highlight")
                  .map(({ id }) => id),
              ],
            },
            elements,
          },
          cancellation,
        )),
    prepareElementRemoval:
      options.prepareElementRemoval ??
      (async (ids, cancellation) => {
        const scheduler = {
          isCancelled: () => cancellation.isCancelled(),
          shouldYield: () => false,
          yieldControl: () => Promise.resolve(),
        };
        const mutation = await options.store.createRemovalMutationTimeSliced(ids, scheduler);
        if (mutation === "cancelled") return { status: "cancelled", token: null };
        if (mutation === null) return { status: "noop", token: null };
        return options.prepareElementMutation(mutation, cancellation);
      }),
  };
}

export function createDeferredPreparation(): {
  complete(): void;
  readonly promise: Promise<{
    readonly status: "prepared";
    readonly token: PreparedElementMutation;
  }>;
} {
  let resolve: (() => void) | undefined;
  const promise = new Promise<void>((complete) => {
    resolve = complete;
  }).then(() => ({ status: "prepared" as const, token: createPreparedToken() }));
  return {
    complete: () => {
      if (resolve === undefined) throw new Error("Preparation is not pending.");
      resolve();
    },
    promise,
  };
}

export function createPreparedToken(): PreparedElementMutation {
  return Object.freeze({}) as PreparedElementMutation;
}

export function createPastePlan(element: InkElementV1): PastePlan {
  const pasted = {
    ...structuredClone(element),
    id: "00000000-0000-4000-8000-000000000999",
  };
  return {
    activateTool: "select",
    commandTimestamp: 1,
    contentIds: [pasted.id],
    elements: [pasted],
    highlightIds: [],
    insertAtBandFront: true,
    repeatState: { fingerprint: "fixture", pasteCount: 1 },
    selectedIds: [pasted.id],
    translation: { x: 0, y: 0 },
  };
}

export function selectedRectangle(): InkElementV1 {
  return createDragElement({
    defaults: createBuiltInSettings().toolDefaults,
    end: { x: 200, y: 200 },
    identity: { createdAt: 1, id: "00000000-0000-4000-8000-000000000001" },
    start: { x: 100, y: 100 },
    tool: "rectangle",
  });
}
