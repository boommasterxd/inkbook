// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { EditorToolbarMenuSession } from "../../../../src/obsidian/menus/editor-toolbar-menu";
import { createTextStyleControls } from "../../../../src/obsidian/menus/text-style-controls";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { installPhoneDialogTestLifecycle } from "../../../fixtures/obsidian/dialog";
import { createOwnedToolbarMenuFixture } from "../../../fixtures/obsidian/owned-toolbar-menu";
import { appendOwnedIframe } from "../../../fixtures/obsidian/owned-iframe";
import { installNativeMenuMeasurementStyles } from "../../../adapters/obsidian/editor-toolbar-menu";
import { nativeModalStack, simulateNativeModalBack } from "../../../adapters/obsidian/settings";

installPhoneDialogTestLifecycle();
beforeEach(installNativeMenuMeasurementStyles);
const sessions: EditorToolbarMenuSession[] = [];
afterEach(() => {
  sessions.splice(0).forEach((session) => session.close("immediate"));
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "visualViewport");
});

function sourceInput(ownerDocument = document) {
  const input = ownerDocument.createElement("input");
  input.setAttribute("aria-label", "Text source");
  ownerDocument.body.append(input);
  return input;
}

function openStyle(
  readTarget: () => HTMLElement | undefined,
  onOcclusionChanged?: (top: number | undefined) => void,
) {
  const result = createOwnedToolbarMenuFixture({
    initialMenu: "style",
    motion: "reduced",
    externalFocusTarget: readTarget,
    ...(onOcclusionChanged === undefined ? {} : { onOcclusionChanged }),
    state: { styleControls: createTextStyleControls(createBuiltInSettings().toolDefaults.text) },
  });
  sessions.push(result.session);
  vi.advanceTimersByTime(50);
  const surface = document.querySelector<HTMLElement>(
    '.inkbook-adaptive-panel[data-kind="style"]',
  )!;
  const control = surface.querySelector<HTMLInputElement>(
    'input[type="range"][aria-label="Font size"]',
  )!;
  return { ...result, surface, control };
}

it("keeps only its owned source focusable and projects changing modal state without repeated writes", () => {
  const source = sourceInput();
  let target: HTMLElement | undefined = source;
  const panel = openStyle(() => target);
  expect(panel.surface.getAttribute("aria-modal")).toBe("false");
  source.focus();
  expect(document.activeElement).toBe(source);
  expect(panel.options.onClosed).not.toHaveBeenCalled();
  const tab = new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
  source.dispatchEvent(tab);
  expect(tab.defaultPrevented).toBe(false);
  panel.control.focus();
  const next = panel.surface.querySelector<HTMLInputElement>(
    'input[type="number"][aria-label="Font size"]',
  )!;
  panel.control.dispatchEvent(
    new KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true }),
  );
  expect(document.activeElement).toBe(next);
  const foreign = sourceInput();
  foreign.focus();
  expect(document.activeElement).toBe(next);
  const writes = vi.spyOn(panel.surface, "setAttribute");
  panel.session.refreshStyle();
  expect(writes).not.toHaveBeenCalledWith("aria-modal", expect.anything());
  target = undefined;
  panel.session.refreshStyle();
  expect(panel.surface.getAttribute("aria-modal")).toBe("true");
  source.focus();
  expect(document.activeElement).toBe(next);
  expect(simulateNativeModalBack(document)).toBe(true);
  expect(panel.options.onClosed).toHaveBeenCalledOnce();
  expect(nativeModalStack(document)).toHaveLength(0);
  source.focus();
  expect(document.activeElement).toBe(source);
});

it("accepts only the owning iframe and rejects its detached or foreign peers", () => {
  const { frame, document: child } = appendOwnedIframe();
  const source = sourceInput(child);
  const panel = openStyle(() => source);
  frame.focus();
  expect(document.activeElement).toBe(frame);
  const foreign = document.createElement("iframe");
  document.body.append(foreign);
  panel.control.focus();
  foreign.focus();
  expect(document.activeElement).toBe(panel.control);
  frame.remove();
  panel.session.refreshStyle();
  expect(panel.surface.getAttribute("aria-modal")).toBe("true");
});

it("keeps Background modal when the same toolbar caller owns an external source", () => {
  const source = sourceInput();
  const onOcclusionChanged = vi.fn();
  const panel = createOwnedToolbarMenuFixture({
    initialMenu: "overflow",
    motion: "reduced",
    externalFocusTarget: () => source,
    onOcclusionChanged,
  });
  sessions.push(panel.session);
  vi.advanceTimersByTime(50);
  const background = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (item) => item.textContent === "Background",
  )!;
  background.click();
  vi.advanceTimersByTime(50);
  const surface = document.querySelector<HTMLElement>(".inkbook-adaptive-panel")!;
  expect(surface.getAttribute("aria-modal")).toBe("true");
  source.focus();
  expect(surface.contains(document.activeElement)).toBe(true);
  expect(panel.session.occlusionTop).toBeUndefined();
  expect(onOcclusionChanged).not.toHaveBeenCalled();
});

it("publishes cached phone Style occlusion after viewport layout and clears it when closed", () => {
  const source = sourceInput();
  const changed = vi.fn();
  const panel = openStyle(() => source, changed);
  const read = vi
    .spyOn(panel.surface, "getBoundingClientRect")
    .mockReturnValue(new DOMRect(0, 320, 360, 480));
  changed.mockClear();
  for (let event = 0; event < 3; event += 1) window.dispatchEvent(new Event("resize"));
  vi.advanceTimersByTime(50);
  expect(panel.session.occlusionTop).toBe(320);
  expect(changed).toHaveBeenCalledExactlyOnceWith(320);
  const measurements = read.mock.calls.length;
  panel.session.refreshStyle();
  expect(panel.session.occlusionTop).toBe(320);
  expect(read).toHaveBeenCalledTimes(measurements);
  read.mockReturnValue(new DOMRect(0, 100, 360, 330));
  window.dispatchEvent(new Event("resize"));
  vi.advanceTimersByTime(50);
  expect(panel.session.occlusionTop).toBe(100);
  expect(changed).toHaveBeenLastCalledWith(100);
  panel.session.close("immediate");
  expect(panel.session.occlusionTop).toBeUndefined();
  expect(changed).toHaveBeenLastCalledWith(undefined);
});

it("reserves space above the active text inspector when the phone keyboard shrinks the viewport", () => {
  vi.spyOn(window, "innerHeight", "get").mockReturnValue(800);
  const viewport = Object.assign(new EventTarget(), {
    width: 360,
    height: 800,
    offsetLeft: 0,
    offsetTop: 0,
  });
  Object.defineProperty(window, "visualViewport", { configurable: true, value: viewport });
  const source = sourceInput();
  let target: HTMLElement | undefined = source;
  const panel = openStyle(() => target);
  const layer = panel.surface.closest<HTMLElement>(".inkbook-adaptive-panel-layer")!;
  const maximum = () =>
    Number.parseFloat(layer.style.getPropertyValue("--inkbook-adaptive-panel-maximum-height"));
  expect(maximum()).toBe(480);
  viewport.height = 450;
  viewport.dispatchEvent(new Event("resize"));
  vi.advanceTimersByTime(50);
  expect(maximum()).toBe(270);
  expect(viewport.height - maximum()).toBe(180);
  target = undefined;
  panel.session.refreshStyle();
  viewport.dispatchEvent(new Event("resize"));
  vi.advanceTimersByTime(50);
  expect(maximum()).toBe(450);
});
