// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { Platform } from "obsidian";
import { EditorToolbarMenuSession } from "../../../../src/obsidian/menus/editor-toolbar-menu";
import { createTextStyleControls } from "../../../../src/obsidian/menus/text-style-controls";
import { textSelectionSummary } from "../../../../src/obsidian/embeds/active-editor/text-session-presentation";
import { parseTextMarkdown } from "../../../fixtures/domain/text-source";
import { textElement } from "../../../unit/domain/schema/fixtures";
import {
  createEditorToolbarMenuOptions,
  installNativeMenuMeasurementStyles,
} from "../../../adapters/obsidian/editor-toolbar-menu";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";

const sessions: EditorToolbarMenuSession[] = [];
beforeEach(() => {
  installObsidianDomHelpers();
  installNativeMenuMeasurementStyles();
  vi.useFakeTimers();
  Platform.isPhone = false;
  Platform.isMobile = false;
});
afterEach(() => {
  sessions.splice(0).forEach((session) => session.close("immediate"));
  vi.useRealTimers();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function fixture() {
  const source = "plain\n\n**bold** `code`";
  const code = source.indexOf("code");
  const element = { ...textElement(), source, style: { ...textElement().style, fontSize: 24 } };
  const documentModel = parseTextMarkdown(source, {
    style: element.style,
    paragraphs: [{ start: 7, alignment: "center" }],
    ranges: [
      {
        start: code,
        end: code + 4,
        style: {
          fontSize: 512.375,
          underline: true,
          strikethrough: true,
          opacity: 0.4,
          color: { type: "rgba", value: "#EF4444FF" },
          backgroundColor: { type: "rgba", value: "#3B82F6FF" },
          backgroundOpacity: 0.5,
        },
      },
    ],
  });
  let controls = createTextStyleControls(textSelectionSummary(element, documentModel, 2, 2));
  const configured = createEditorToolbarMenuOptions();
  const session = new EditorToolbarMenuSession({
    ...configured,
    initialMenu: "style",
    getState: () => ({ ...configured.getState(), styleControls: controls }),
  });
  sessions.push(session);
  vi.advanceTimersByTime(240);
  const panel = document.querySelector<HTMLElement>('.inkbook-adaptive-panel[data-kind="style"]')!;
  const field = (id: string) => panel.querySelector<HTMLElement>(`[data-control="${id}"]`)!;
  const button = (id: string) => field(id).querySelector<HTMLButtonElement>("button")!;
  return {
    session,
    panel,
    field,
    button,
    onChange: configured.handlers.onStyleChange,
    code,
    move: (start: number, end = start) => {
      controls = createTextStyleControls(textSelectionSummary(element, documentModel, start, end));
      session.refreshStyle();
    },
  };
}

it("projects fresh source selection styles into retained menu controls and deduplicates equal summaries", async () => {
  const f = fixture();
  const nodes = [...f.panel.querySelectorAll("*")];
  const bold = f.button("text-bold");
  expect(bold.getAttribute("aria-pressed")).toBe("false");
  f.move(9);
  expect(bold.getAttribute("aria-pressed")).toBe("true");
  f.move(f.code);
  expect(bold.getAttribute("aria-pressed")).toBe("false");
  expect(f.button("text-underline").getAttribute("aria-pressed")).toBe("true");
  expect(f.button("text-strikethrough").getAttribute("aria-pressed")).toBe("true");
  expect(
    f.field("text-font-size").querySelector<HTMLInputElement>('input[type="number"]')?.value,
  ).toBe("512.375");
  f.field("text-font-size")
    .querySelector<HTMLInputElement>('input[type="number"]')!
    .dispatchEvent(new Event("change"));
  expect(f.onChange).not.toHaveBeenCalled();
  expect(
    f.field("text-font-size").querySelector<HTMLInputElement>('input[type="range"]')?.value,
  ).toBe("100");
  expect(f.field("opacity").querySelector<HTMLInputElement>('input[type="number"]')?.value).toBe(
    "40",
  );
  expect(
    f.field("color").querySelector('[data-value="#EF4444FF"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    f
      .field("text-background-color")
      .querySelector('[data-value="#3B82F6FF"]')
      ?.getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    f.field("text-background-opacity").querySelector<HTMLInputElement>('input[type="number"]')
      ?.value,
  ).toBe("50");
  expect(
    f.field("text-alignment").querySelector('[data-value="center"]')?.getAttribute("aria-pressed"),
  ).toBe("true");
  f.move(2, f.code + 4);
  expect(bold.getAttribute("aria-pressed")).toBe("mixed");
  await vi.advanceTimersByTimeAsync(240);
  const records: MutationRecord[] = [];
  const observer = new MutationObserver((batch) => records.push(...batch));
  observer.observe(f.panel, { subtree: true, attributes: true, childList: true });
  f.session.refreshStyle();
  f.move(2, f.code + 4);
  await Promise.resolve();
  observer.disconnect();
  expect(records).toEqual([]);
  expect([...f.panel.querySelectorAll("*")]).toEqual(nodes);
});

it("preserves an open font list and an active numeric draft while source context changes", () => {
  const f = fixture();
  const family = f.button("text-font-family");
  family.click();
  const list = document.getElementById(family.getAttribute("aria-controls")!)!;
  const active = family.getAttribute("aria-activedescendant");
  f.move(f.code);
  expect(family.getAttribute("aria-expanded")).toBe("true");
  expect(document.getElementById(family.getAttribute("aria-controls")!)).toBe(list);
  expect(family.getAttribute("aria-activedescendant")).toBe(active);
  expect(family.dataset.value).toBe("jetbrains-mono");
  family.click();
  const size = f.field("text-font-size").querySelector<HTMLInputElement>('input[type="number"]')!;
  size.focus();
  size.value = "45.625";
  size.dispatchEvent(new Event("input"));
  f.move(9);
  expect(document.activeElement).toBe(size);
  expect(size.value).toBe("45.625");
  expect(f.button("text-bold").getAttribute("aria-pressed")).toBe("true");
  f.button("text-bold").focus();
  expect(size.value).toBe("24");
});
