import { EditorView } from "@codemirror/view";
import { afterEach, expect, vi } from "vitest";
import type { FontResourceV2, TextElementV2 } from "../../../src/domain/schema/public";
import { ElementStore } from "../../../src/domain/store/public";
import { parseTextMarkdown } from "../domain/text-source";
import type { SvgSceneRenderer } from "../../../src/rendering/scene/index";
import type { TextEditingCallbacks } from "../../../src/rendering/scene/text-editing-surface";
import { ActiveEditorHistory } from "../../../src/obsidian/embeds/active-editor/history";
import { ActiveTextPreparation } from "../../../src/obsidian/embeds/active-editor/text-preparation";
import {
  ActiveTextSession,
  type ActiveTextSessionOptions,
} from "../../../src/obsidian/embeds/active-editor/text-session";
import type { EditableDocumentModel } from "../../../src/obsidian/embeds/document-session/document-model-port";
import { textElement } from "../../unit/domain/schema/fixtures";
import { elementMutationPorts, elementReplacementPorts } from "./element-mutation-ports";
import { immediateWorkScheduler } from "./immediate-work-scheduler";
import { expandLegacyTextPaddingSteps } from "../../../src/domain/geometry/text-padding";
import { finishGeometrySteps } from "../domain/geometry-steps";

/** Owns mounted sessions, their mock adapters and document nodes for one test suite. */
export function useActiveTextSessions() {
  const sessions: ActiveTextSession[] = [];
  afterEach(() => {
    sessions.splice(0).forEach((session) => session.dispose());
    vi.restoreAllMocks();
    document.body.replaceChildren();
  });
  return (
    element = textElement(),
    legacy = false,
    onRevealBounds?: ActiveTextSessionOptions["onRevealBounds"],
  ) => {
    const state = mountActiveTextSession({ element, legacy, onRevealBounds });
    sessions.push(state.session);
    return state;
  };
}

/** Opens a native session and selects a range without synchronous DOM selection feedback. */
export async function openTextSessionRange(
  state: ReturnType<typeof mountActiveTextSession>,
  range: { readonly anchor: number; readonly head: number },
): Promise<EditorView> {
  await state.session.edit(state.element.id);
  const input = state.input();
  input.contentDOM.blur();
  input.dispatch({ selection: range });
  return input;
}

/** Exercise source-owned undo/redo and await the replacement native input. */
export async function navigateActiveTextHistory(
  state: ReturnType<typeof mountActiveTextSession>,
  redo = false,
) {
  const previous = state.input();
  previous.contentDOM.dispatchEvent(
    new KeyboardEvent("keydown", {
      key: redo ? "y" : "z",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }),
  );
  await vi.waitFor(() => {
    expect(state.input()).toBeTruthy();
    expect(state.input()).not.toBe(previous);
  });
}

vi.mock("../../../src/rendering/text/canvas-text-measurer", async () => ({
  CanvasTextMeasurer: (await import("../rendering/fixed-text-measurer")).FixedTextMeasurer,
}));

export function activeTextLayout(element: TextElementV2): TextElementV2 {
  const padding = element.layout.padding ?? 0;
  const height = 32 + padding * 2;
  return {
    ...element,
    height,
    pivot: { x: element.x + element.width / 2, y: element.y + height / 2 },
    layout: {
      version: 1,
      ...(element.layout.padding === undefined ? {} : { padding: element.layout.padding }),
      lines: [
        {
          x: padding,
          y: padding,
          width: element.width - padding * 2,
          height: 32,
          baseline: 24,
          runs: [
            {
              text: element.source,
              start: 0,
              end: element.source.length,
              x: 0,
              width: element.width - padding * 2,
            },
          ],
        },
      ],
    },
  };
}

/** Logical faces for session tests whose native font loading boundary is controlled. */
export function textSessionFontResources(): FontResourceV2[] {
  return [
    { family: "inter", weight: 400, id: "a".repeat(64) },
    { family: "inter", weight: 700, id: "b".repeat(64) },
    { family: "jetbrains-mono", weight: 400, id: "c".repeat(64) },
  ].map((face) => ({ ...face, style: "normal", mimeType: "font/woff2", data: "AA==" }));
}

function createModel(element: TextElementV2) {
  const store = new ElementStore([element]);
  let revision = 0;
  let operations = 0;
  let exportPreparation: (() => Promise<void>) | undefined;
  const model = {
    store,
    get revision() {
      return revision;
    },
    mutationAvailability: "available",
    beginInteractiveOperation: () => {
      operations += 1;
      return () => {
        operations -= 1;
      };
    },
    registerExportPreparation: (prepare: () => Promise<void>) => {
      exportPreparation = prepare;
      return () => {
        if (exportPreparation === prepare) exportPreparation = undefined;
      };
    },
    ...elementReplacementPorts(store, () => {
      revision += 1;
    }),
    ...elementMutationPorts(store, () => {
      revision += 1;
    }),
  } as unknown as EditableDocumentModel;
  return {
    model,
    operations: () => operations,
    prepareExport: async () => {
      await exportPreparation?.();
    },
    hasExportPreparation: () => exportPreparation !== undefined,
  };
}

function pageBoundsForClientRect(rect: DOMRect) {
  return { minX: rect.left, maxX: rect.right, minY: rect.top, maxY: rect.bottom };
}

/** Real CodeMirror/history with a renderer/layout adapter; optionally exercises the actual document session. */
export function mountActiveTextSession(
  options: {
    readonly element?: TextElementV2;
    readonly model?: EditableDocumentModel;
    readonly legacy?: boolean;
    readonly onRevealBounds?: ActiveTextSessionOptions["onRevealBounds"];
  } = {},
) {
  const source = options.element ?? textElement();
  const element =
    options.legacy || source.layout.padding !== undefined
      ? source
      : finishGeometrySteps(expandLegacyTextPaddingSteps(source));
  const owned = createModel(element);
  const model = options.model ?? owned.model;
  const container = document.createElement("div");
  document.body.append(container);
  const dispose = vi.fn(() => container.replaceChildren());
  const bounds = vi.fn();
  const suspended = vi.fn();
  let outside: ((event: PointerEvent) => void) | undefined;
  let ownsPointerTarget: TextEditingCallbacks["ownsPointerTarget"];
  let viewportChanged: (() => void) | undefined;
  let geometryChanged: TextEditingCallbacks["onGeometryChanged"];
  const renderer = {
    textDocument: document,
    setTextFonts: vi.fn(),
    beginPreviewCommit: () => ({ arm: () => true, cancel: vi.fn() }),
    suppressMotionForNextDelta: vi.fn(),
    waitForTextElement: vi.fn(async () => true),
    beginTextEditing: vi.fn((_id: string, callbacks: TextEditingCallbacks) => {
      outside = callbacks.onOutsidePointerDown;
      ownsPointerTarget = callbacks.ownsPointerTarget;
      viewportChanged = callbacks.onViewportChanged;
      geometryChanged = callbacks.onGeometryChanged;
      return {
        container,
        ownerDocument: document,
        dispose,
        updateBounds: bounds,
        setVisibility: vi.fn(),
        setSuspended: suspended,
        setContentHeight: vi.fn(() => undefined),
        pageBoundsForClientRect,
      };
    }),
  } as unknown as SvgSceneRenderer;
  const prepare = vi
    .spyOn(ActiveTextPreparation.prototype, "prepare")
    .mockImplementation(async (next) => activeTextLayout(next));
  vi.spyOn(ActiveTextPreparation.prototype, "open").mockResolvedValue(undefined);
  vi.spyOn(ActiveTextPreparation.prototype, "document").mockImplementation((next) =>
    parseTextMarkdown(next.source, next),
  );
  const history = new ActiveEditorHistory(model);
  const error = vi.fn();
  const selection = vi.fn();
  const session = new ActiveTextSession({
    model,
    history,
    renderer,
    ownerWindow: window,
    scheduler: immediateWorkScheduler(),
    defaults: () => ({
      ...element.style,
      alignment: "left",
      backgroundColor: null,
      backgroundOpacity: 1,
    }),
    onError: error,
    onSelection: selection,
    onStateChanged: vi.fn(),
    ...(options.onRevealBounds ? { onRevealBounds: options.onRevealBounds } : {}),
  });
  return {
    ...owned,
    model,
    session,
    element,
    history,
    container,
    prepare,
    error,
    selection,
    dispose,
    bounds,
    suspended,
    renderer,
    viewportChanged: () => viewportChanged?.(),
    geometryChanged: (element: TextElementV2) => geometryChanged?.(element),
    input: () => EditorView.findFromDOM(container.querySelector(".cm-editor")!)!,
    outside: (target: Element) => {
      if (!ownsPointerTarget?.(target)) outside?.({ target } as unknown as PointerEvent);
    },
  };
}
