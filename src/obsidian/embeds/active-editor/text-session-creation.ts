import { canonicalizeGeometryNumber, type TextElementV2 } from "../../../domain/schema/public";
import type { TextDefaultsV2 } from "../../../domain/settings/types";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import { registerAppliedDocumentMutation } from "./document-history";
import type { ActiveEditorHistory } from "./history";
import type { ProvisionalTextCreation } from "./text-provisional-creation";
import { textPaddingForWidth } from "../../../domain/geometry/text-padding";

export async function appendCreatedTextField(
  element: TextElementV2,
  options: {
    readonly model: EditableDocumentModel;
    readonly history: ActiveEditorHistory;
    readonly creation: ProvisionalTextCreation;
    readonly edit: boolean;
    readonly isDisposed: () => boolean;
    readonly onSelection: (selection: ReadonlySet<string>) => void;
    readonly onStateChanged: () => void;
    readonly mount: (element: TextElementV2) => Promise<boolean>;
  },
): Promise<boolean> {
  const revision = options.model.revision;
  const isCancelled = () =>
    options.isDisposed() ||
    options.history.isDisposed ||
    options.history.isTraversing ||
    options.model.revision !== revision;
  const prepared = await options.model.prepareElementAppend([element], { isCancelled });
  if (prepared.status !== "prepared" || prepared.token === null || isCancelled()) return false;
  const applied = options.model.commitPreparedElementMutation(prepared.token);
  if (applied === null) return false;
  if (options.edit && element.source.trim().length === 0)
    options.creation.begin(element.id, applied.payloadBytes);
  else registerAppliedDocumentMutation(options.history, options.model, applied);
  options.onSelection(new Set([element.id]));
  options.onStateChanged();
  let mounted = false;
  try {
    mounted = !options.edit || (await options.mount(element));
    return mounted;
  } finally {
    if (!mounted && options.creation.pending && (await options.creation.discard())) {
      options.onSelection(new Set());
      options.onStateChanged();
    }
  }
}

/** Initial text geometry enters the existing cooperative layout and store preparation pipeline. */
export function createTextFieldDraft(
  box: { readonly x: number; readonly y: number; readonly width: number },
  source: string,
  defaults: TextDefaultsV2,
  identity: { readonly id: string; readonly createdAt: number },
): TextElementV2 {
  const { backgroundColor, backgroundOpacity, alignment, ...style } = defaults;
  const x = canonicalizeGeometryNumber(box.x);
  const y = canonicalizeGeometryNumber(box.y);
  const width = canonicalizeGeometryNumber(box.width);
  if (width <= 0) throw new RangeError("A text field requires a positive width.");
  return {
    ...identity,
    kind: "text",
    x,
    y,
    width,
    height: style.fontSize,
    rotation: 0,
    pivot: { x, y },
    source,
    style,
    ranges: [],
    paragraphs: [{ start: 0, alignment }],
    backgroundColor,
    backgroundOpacity,
    layout: { version: 1, padding: textPaddingForWidth(style.fontSize, width), lines: [] },
  };
}
