import { EditorView } from "@codemirror/view";
import type { TextStyleV2 } from "../../../domain/schema/public";
import { fontCssFamily, fontResourceCssFamily } from "../../../domain/text/font-family";
import {
  TEXT_CODE_FONT_FAMILY,
  TEXT_HEADING_SCALES,
  TEXT_LINE_HEIGHT,
  TEXT_TAB_SIZE,
  TEXT_LIST_MARKER_GAP_EM,
} from "../../../domain/text/text-layout-style";
import { textTableThemeRules } from "./text-table-theme";

export function textStyleCss(style: TextStyleV2, fontResourceId?: string): string {
  const decoration = [style.underline ? "underline" : "", style.strikethrough ? "line-through" : ""]
    .filter(Boolean)
    .join(" ");
  return `${textFontCss(style, fontResourceId)};text-decoration:${decoration || "none"};color:${style.color.type === "rgba" ? style.color.value : "var(--inkbook-text-color, #222222)"};opacity:${style.opacity}`;
}

export function textFontCss(style: TextStyleV2, fontResourceId?: string): string {
  const family =
    fontResourceId === undefined
      ? fontCssFamily(style.fontFamily)
      : fontResourceCssFamily(fontResourceId);
  return `font-family:"${family}";font-size:${style.fontSize}px;font-weight:${style.bold ? 700 : 400};font-style:${style.italic ? "italic" : "normal"}`;
}

/** No host editor settings or DOM are inspected. Parent relays documented theme tokens. */
export const textFieldTheme = EditorView.theme({
  "&": { height: "auto", minHeight: "1em", outline: "none", background: "transparent" },
  "&.cm-focused": { outline: "none" },
  "&.inkbook-text-background-owner": { isolation: "isolate" },
  ".inkbook-text-editor-background": {
    position: "absolute",
    left: "0",
    top: "0",
    width: "100%",
    height: "100%",
    overflow: "visible",
    pointerEvents: "none",
    zIndex: "-1",
  },
  ".cm-scroller": {
    overflow: "visible",
    fontFamily: "inherit",
    lineHeight: String(TEXT_LINE_HEIGHT),
  },
  ".cm-content": {
    padding: "0",
    minHeight: "1em",
    caretColor: "currentColor",
    overflowWrap: "anywhere",
    tabSize: String(TEXT_TAB_SIZE),
  },
  ".cm-line": { padding: "0" },
  ".inkbook-text-line-boundary": {
    height: "0",
    width: "0",
    minHeight: "0",
    margin: "0",
    padding: "0",
    border: "0",
    pointerEvents: "none",
  },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "currentColor" },
  ".cm-selectionBackground": { backgroundColor: "var(--text-selection, #3985d84d)" },
  ".cm-formatting": { color: "var(--text-faint, #888888)", fontWeight: "normal" },
  ".cm-strong": { fontWeight: "700" },
  ".cm-em": { fontStyle: "italic" },
  ".cm-strikethrough": { textDecoration: "line-through" },
  ".cm-inline-code": { fontFamily: `inkbook-${TEXT_CODE_FONT_FAMILY}` },
  ".cm-math": {
    color: "var(--code-normal, #d19a66)",
    fontFamily: `inkbook-${TEXT_CODE_FONT_FAMILY}`,
  },
  ".cm-math.cm-tag": { color: "var(--code-tag, #e93147)" },
  ".cm-math.cm-variable-2": { color: "var(--code-property, #00bfbc)" },
  ".cm-math.cm-number": { color: "var(--code-value, #7852ee)" },
  ".cm-math.cm-bracket": { color: "var(--code-punctuation, #888888)" },
  ".cm-math.cm-comment": { color: "var(--code-comment, var(--text-faint, #888888))" },
  ".cm-formatting-math": { color: "var(--text-accent, #8a5cf5)" },
  ".cm-header": { fontWeight: "700" },
  ...Object.fromEntries(
    TEXT_HEADING_SCALES.map((scale, index) => [
      `.cm-header-${index + 1}`,
      { fontSize: `${scale}em` },
    ]),
  ),
  ".inkbook-text-math-widget": {
    display: "inline-block",
    verticalAlign: "baseline",
    cursor: "text",
    maxWidth: "100%",
  },
  ".inkbook-text-math-display": { display: "block" },
  // about:blank uses quirks mode: a real glyph retains the native font strut around an SVG.
  ".inkbook-text-math-display::before": { content: '"\\200B"' },
  ".inkbook-text-math-literal": { textAlign: "inherit", whiteSpace: "pre-wrap" },
  ".inkbook-text-math-content": { display: "inline-block" },
  ".inkbook-text-math-content > svg": { display: "block" },
  ".inkbook-text-table-widget": { position: "relative", width: "100%" },
  ".inkbook-text-table-widget table": {
    width: "100%",
    tableLayout: "fixed",
    borderCollapse: "collapse",
    margin: "0",
    border: "0",
  },
  ".inkbook-text-table-widget th, .inkbook-text-table-widget td": {
    padding: "0",
    border: "0",
    verticalAlign: "top",
  },
  ".inkbook-text-table-widget button[data-inkbook-source]": {
    display: "block",
    width: "100%",
    height: "100%",
    minHeight: "0",
    padding: "0",
    margin: "0",
    border: "0",
    borderRadius: "0",
    boxShadow: "none",
    background: "transparent",
    color: "inherit",
    font: "inherit",
    textAlign: "inherit",
    whiteSpace: "normal",
    overflowWrap: "anywhere",
    cursor: "text",
  },
  ".inkbook-text-table-ready table": { position: "absolute", inset: "0", height: "100%" },
  ".inkbook-text-table-ready button[data-inkbook-source]": { color: "transparent", fontSize: "0" },
  ".inkbook-text-table-spacer": { lineHeight: "0" },
  ".inkbook-text-table-widget button:focus-visible": {
    outline: "2px solid var(--interactive-accent, #8a5cf5)",
    outlineOffset: "-2px",
  },
  ".inkbook-text-table-paint, .inkbook-text-table-paint > svg": { display: "block" },
  ...textTableThemeRules,
  ".inkbook-text-list-marker": {
    display: "inline-block",
    width: "0",
    position: "relative",
    whiteSpace: "nowrap",
  },
  ".inkbook-text-list-marker > span": {
    display: "inline-block",
    position: "relative",
    transform: `translateX(calc(-100% - ${TEXT_LIST_MARKER_GAP_EM}em))`,
  },
});
