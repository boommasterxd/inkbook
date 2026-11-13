import type { TextElementV2 } from "../../../domain/schema/public";
import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import type { ElementStore } from "../../../domain/store/public";
import type { EditorTool } from "../../../editor/input/index";
import {
  summarizeTextStyle,
  type TextSelectionStyleSummary,
} from "../../../editor/tools/text-style-summary";
import type { ToolbarStyleIconState } from "../../../rendering/ui/style-icon";

export function textToolbarIcon(
  values: TextSelectionStyleSummary | ToolDefaultsV1["text"],
): ToolbarStyleIconState {
  const style = "kind" in values ? values.style : values;
  return {
    fillColor: values.backgroundColor === "mixed" ? null : values.backgroundColor,
    fillOpacity: values.backgroundOpacity === "mixed" ? 0 : values.backgroundOpacity,
    outlineColor: style.color === "mixed" ? null : style.color,
    outlineStyle: "solid",
    text: {
      bold: style.bold === "mixed" ? null : style.bold,
      italic: style.italic === "mixed" ? null : style.italic,
      strikethrough: style.strikethrough === "mixed" ? null : style.strikethrough,
      underline: style.underline === "mixed" ? null : style.underline,
    },
  };
}

/** Retain one selection snapshot; unrelated commits never rescan its text runs. */
export function createSelectedTextToolbarIcon(
  store: ElementStore,
  selection: () => ReadonlySet<string>,
): (tool: EditorTool) => ToolbarStyleIconState | undefined {
  let previousSelection: ReadonlySet<string> | undefined;
  let previousVersion = -1;
  let previousElements: readonly TextElementV2[] = [];
  let icon: ToolbarStyleIconState | undefined;
  let nonText = false;
  return (tool) => {
    const selected = selection();
    if (previousSelection !== selected || previousVersion !== store.mutationVersion) {
      previousSelection = selected;
      previousVersion = store.mutationVersion;
      const elements: TextElementV2[] = [];
      nonText = false;
      for (const id of selected) {
        const element = store.get(id)?.element;
        if (element?.kind !== "text") {
          nonText = true;
          break;
        }
        elements.push(element as TextElementV2);
      }
      if (nonText || !elements.length) icon = undefined;
      else if (!sameTextPaint(elements, previousElements))
        icon = textToolbarIcon(summarizeTextStyle(elements));
      previousElements = nonText ? [] : elements;
    }
    return nonText && tool === "text"
      ? { fillColor: null, fillOpacity: 0, outlineColor: null, outlineStyle: "solid" }
      : icon;
  };
}

function sameTextPaint(left: readonly TextElementV2[], right: readonly TextElementV2[]): boolean {
  return (
    left.length === right.length &&
    left.every((element, index) => {
      const previous = right[index]!;
      return (
        element === previous ||
        (element.style === previous.style &&
          element.layout === previous.layout &&
          element.backgroundColor === previous.backgroundColor &&
          element.backgroundOpacity === previous.backgroundOpacity)
      );
    })
  );
}
