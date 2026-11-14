import { expect, it } from "vitest";
import { createBuiltInSettings } from "../../../../../src/domain/settings/defaults";
import { ElementStore } from "../../../../../src/domain/store/public";
import { createActiveEditorStyleIcon } from "../../../../../src/obsidian/embeds/active-editor/controller-styles";
import { createSelectedTextToolbarIcon } from "../../../../../src/obsidian/embeds/active-editor/text-toolbar-icon";
import { textElement } from "../../../domain/schema/fixtures";
import { indexedStroke } from "../../../../fixtures/editor/stroke";

it("projects the effective Text-tool defaults without changing the other tool presentation", () => {
  const defaults = createBuiltInSettings().toolDefaults;
  defaults.text = {
    ...defaults.text,
    bold: true,
    italic: true,
    strikethrough: true,
    underline: true,
    color: { type: "rgba", value: "#3B82F6FF" },
    backgroundColor: { type: "rgba", value: "#FACC15FF" },
    backgroundOpacity: 0.35,
  };
  expect(createActiveEditorStyleIcon(defaults, "text")).toMatchObject({
    outlineColor: defaults.text.color,
    fillColor: defaults.text.backgroundColor,
    fillOpacity: 0.35,
    text: { bold: true, italic: true, strikethrough: true, underline: true },
  });
  expect(createActiveEditorStyleIcon(defaults, "draw")).not.toHaveProperty("text");
});

it("tracks the common text selection, style replacement and return to an empty selection", () => {
  const first = textElement(80);
  first.style = { ...first.style, bold: true, italic: true, strikethrough: true };
  const second = { ...textElement(81), style: { ...first.style, bold: false } };
  const store = new ElementStore([first, second]);
  let selection = new Set([first.id, second.id]);
  const icon = createSelectedTextToolbarIcon(store, () => selection);
  expect(icon("select")?.text).toEqual({
    bold: null,
    italic: true,
    strikethrough: true,
    underline: false,
  });
  store.replace(second.id, { ...second, style: { ...first.style } });
  expect(icon("select")?.text?.bold).toBe(true);
  selection = new Set([second.id]);
  store.replace(second.id, { ...second, style: { ...second.style, italic: false } });
  expect(icon("select")?.text).toMatchObject({ bold: false, italic: false });
  selection = new Set();
  expect(icon("text")).toBeUndefined();
});

it("keeps mixed object selections neutral instead of reporting Text defaults as selected formatting", () => {
  const text = textElement();
  const stroke = indexedStroke(0);
  const store = new ElementStore([text, stroke]);
  const selection = new Set([text.id, stroke.id]);
  const icon = createSelectedTextToolbarIcon(store, () => selection);
  expect(icon("text")).not.toHaveProperty("text");
  expect(icon("select")).toBeUndefined();
  expect(icon("draw")).toBeUndefined();
});
