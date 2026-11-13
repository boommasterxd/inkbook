import type { Bounds } from "../../../domain/geometry/public";
import {
  canonicalizeGeometryNumber,
  canonicalizeUnitIntervalNumber,
  type TextElementV2,
} from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { validateTextStyleValue } from "../../../domain/settings/text-style-values";
import { textStyleKey } from "../../../editor/tools/style-change-validation";
import type {
  TextEditingCallbacks,
  TextEditingSurface,
} from "../../../rendering/scene/text-editing-surface";
import { TextFieldEditor, type TextFieldEditorOptions } from "../../text/editor/text-field-editor";
import type { TextTableUiPort } from "../../text/editor/text-table-controls";
import type { ActiveTextPreparation } from "./text-preparation";
import { TextSessionExtent, type TextSourceExtentLayout } from "./text-session-extent";
import { textSessionTablePreview } from "./text-session-table-preview";
import {
  relayTextTheme,
  renderTextMathWidget,
  prepareTextCaretReveal,
  textMenuStyleValue,
  textSelectionSummary,
} from "./text-session-presentation";

interface TextSessionEditorOptions extends Pick<
  TextFieldEditorOptions,
  "onChange" | "onInputPending" | "onError"
> {
  readonly element: TextElementV2;
  readonly tableCellLabel?: string;
  readonly tableUi?: TextTableUiPort;
  readonly surface: TextEditingSurface;
  readonly scheduler: WorkScheduler;
  readonly preparation: ActiveTextPreparation;
  readonly sourceExtentLayout: TextSourceExtentLayout | undefined;
  readonly currentElement: () => TextElementV2 | undefined;
  readonly draft: () => TextElementV2 | undefined;
  readonly onStateChanged: () => void;
  readonly onFinish: () => void;
  readonly onUndoRedo: (redo: boolean) => void;
  readonly onRevealBounds: ((bounds: Bounds) => void) | undefined;
}

export async function prepareTextSessionSurface(
  surface: TextEditingSurface,
  signal: AbortSignal,
): Promise<boolean> {
  try {
    await surface.ready;
    if (!signal.aborted) return true;
  } catch (error) {
    surface.dispose();
    throw error;
  }
  surface.dispose();
  return false;
}

export function textSessionInputCallbacks(
  callbacks: Pick<TextEditingCallbacks, "onPointerDown" | "onKeyDown">,
  finish: () => Promise<boolean>,
): TextEditingCallbacks {
  return {
    ownsPointerTarget: ownsTextSessionPointer,
    ...(callbacks.onPointerDown ? { onPointerDown: callbacks.onPointerDown } : {}),
    ...(callbacks.onKeyDown ? { onKeyDown: callbacks.onKeyDown } : {}),
    onOutsidePointerDown: (event) => finishTextSessionOnOutsidePointer(event, finish),
  };
}

export function textSessionViewportChanged(
  input: () => Pick<TextFieldEditor, "requestViewportMeasure"> | undefined,
  extent: () => Pick<TextSessionExtent, "invalidate"> | undefined,
): (geometryChanged?: boolean) => void {
  return (geometryChanged) => {
    input()?.requestViewportMeasure();
    if (geometryChanged !== false) extent()?.invalidate();
  };
}

/** Composes native source input with its owned text layout, math and viewport adapters. */
export function createTextSessionEditor(options: TextSessionEditorOptions) {
  const { surface, preparation, element } = options;
  let input: TextFieldEditor | undefined;
  relayTextTheme(surface.container);
  const extent = new TextSessionExtent({
    scheduler: options.scheduler,
    surface,
    layout: options.sourceExtentLayout,
    input: () => input,
    canonicalHeight: () => options.currentElement()?.height ?? element.height,
  });
  try {
    input = new TextFieldEditor({
      container: surface.container,
      surfaceCoordinates: surface.coordinates,
      element,
      ...(options.tableCellLabel ? { tableCellLabel: options.tableCellLabel } : {}),
      ...(options.tableUi ? { tableUi: options.tableUi } : {}),
      scheduler: options.scheduler,
      onChange: options.onChange,
      resolveFontResourceId: preparation.resolveFontResourceId,
      fontResourceBoundaries: preparation.fontResourceBoundaries,
      onContentHeightChange: () => extent.invalidate(),
      ...(options.onRevealBounds
        ? {
            prepareScrollIntoView: (rect) =>
              prepareTextCaretReveal(surface, rect, options.onRevealBounds, () => extent.update()),
          }
        : {}),
      ...(options.onInputPending ? { onInputPending: options.onInputPending } : {}),
      parsedDocument: () => {
        const draft = options.draft();
        return draft ? preparation.document(draft) : undefined;
      },
      onSelectionChange: options.onStateChanged,
      onFinish: options.onFinish,
      onUndoRedo: options.onUndoRedo,
      ...(options.onError ? { onError: options.onError } : {}),
      renderTable: async (block, signal, context) => {
        const draft = options.draft() ?? options.currentElement() ?? element;
        const layout = await preparation.prepareTable(block, draft, context.availableWidth, signal);
        return textSessionTablePreview({
          document: surface.ownerDocument,
          block,
          element: draft,
          layout,
          scheduler: options.scheduler,
        });
      },
      renderMath: (latex, display, signal, context) =>
        renderTextMathWidget({
          document: surface.ownerDocument,
          math: preparation.math,
          latex,
          display,
          size:
            context?.fontSize ?? options.currentElement()?.style.fontSize ?? element.style.fontSize,
          width: context?.availableWidth ?? options.currentElement()?.width ?? element.width,
          bold: context?.bold ?? options.currentElement()?.style.bold ?? element.style.bold,
          ...(context?.sourceRange
            ? {
                baselineOffset: (result) =>
                  preparation.mathBaselines.offset(context.sourceRange!, result, context.layout),
              }
            : {}),
          scheduler: options.scheduler,
          signal,
        }),
    });
  } catch (error) {
    extent.dispose();
    throw error;
  }
  return { input, extent };
}

export function textSessionStyleSummary(
  input: TextFieldEditor | undefined,
  element: TextElementV2 | undefined,
  preparation: ActiveTextPreparation | undefined,
) {
  if (!input || !element) return undefined;
  return textSelectionSummary(
    element,
    preparation?.document(element),
    input.originalSourcePosition(input.selectionStart, 1),
    input.originalSourcePosition(input.selectionEnd, -1),
    input.selectionStart === input.selectionEnd ? input.pendingTextStyle : undefined,
  );
}

export function applyTextSessionStyle(
  input: TextFieldEditor,
  id: string,
  raw: boolean | number | string,
): boolean {
  const key = id.startsWith("text-") ? textStyleKey(id) : id;
  let value = textMenuStyleValue(key, raw);
  if (!validateTextStyleValue(key, value)) return false;
  if (key === "fontSize") value = canonicalizeGeometryNumber(value as number);
  else if (key === "opacity" || key === "backgroundOpacity")
    value = canonicalizeUnitIntervalNumber(value as number);
  return validateTextStyleValue(key, value) && input.applyStyle(id, value);
}

export function revealTextSessionCaret(input: TextFieldEditor | undefined, focus = false): void {
  if (!input) return;
  if (focus) input.focusSelectionPreserved();
  if (input.inputView.hasFocus) input.inputView.dispatch({ scrollIntoView: true });
}

function finishTextSessionOnOutsidePointer(
  event: PointerEvent,
  finish: () => void | Promise<boolean>,
): void {
  const target = event.target as Element | null;
  if (
    target?.closest?.(
      ".inkbook-toolbar-shell,.inkbook-adaptive-panel-layer,.inkbook-owned-menu,.inkbook-phone-sheet-host",
    )
  )
    return;
  void finish();
}

/** Floating table chrome is an input surface owned by this text session. */
function ownsTextSessionPointer(target: EventTarget | null): boolean {
  return Boolean((target as Element | null)?.closest?.(".inkbook-text-table-controls-layer"));
}
