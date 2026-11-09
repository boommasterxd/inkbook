import type { ImportHistoryState } from "../../../../src/obsidian/settings/import/import-history";
import { Localization } from "../../../../src/domain/localization";
// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { InkImportJournal } from "../../../../src/obsidian/import/types";
import type { InkImportSettingsAccess } from "../../../../src/obsidian/settings/import/import-access";
import { importSettingsGroup } from "../../../../src/obsidian/settings/import/import-settings";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { assertAccessibleSemantics } from "../../../fixtures/accessibility";
import { renderDefinition, requiredRender, renders } from "./setting-tab-fixture";

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function journal(index = 0): InkImportJournal {
  return {
    version: 1,
    id: `run-${index}`,
    createdAt: new Date(Date.UTC(2026, 9, 1, 12, index)).toISOString(),
    status: index === 999 ? "undone" : "complete",
    sources: [],
    notes: [],
    issues: [],
  };
}

function pendingHistory() {
  let finish: (value: readonly InkImportJournal[]) => void = () => undefined;
  const promise = new Promise<readonly InkImportJournal[]>((resolve) => {
    finish = resolve;
  });
  return { promise, finish };
}

function fixture(signal?: AbortSignal, state?: ImportHistoryState, language: "en" | "de" = "en") {
  const listeners = new Set<() => void>();
  const access = {
    history: vi.fn<InkImportSettingsAccess["history"]>().mockResolvedValue([]),
    open: vi.fn<InkImportSettingsAccess["open"]>().mockResolvedValue(),
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  const group = importSettingsGroup({
    localization: new Localization(language),
    ...(state === undefined ? {} : { state }),
    access,
    signal,
    readMotion: () => "reduced",
  });
  const rendered = renderDefinition(
    requiredRender(renders(group), language === "de" ? "Importverlauf" : "Import history"),
  );
  document.body.append(rendered.container);
  const trigger = button(
    rendered.container,
    language === "de" ? "Importverlauf" : "Import history",
  );
  const panel = document.getElementById(trigger.getAttribute("aria-controls")!);
  if (panel === null) throw new Error("Missing history disclosure panel");
  return {
    ...rendered,
    access,
    group,
    trigger,
    panel,
    changed: () => {
      for (const listener of listeners) listener();
    },
    listenerCount: () => listeners.size,
  };
}

function button(container: HTMLElement, name: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>("button")].find(
    (element) =>
      element.getAttribute("aria-label") === name || element.textContent?.startsWith(name),
  );
  if (found === undefined) throw new Error(`Missing button: ${name}`);
  return found;
}

function rows(container: HTMLElement): NodeListOf<HTMLButtonElement> {
  return container.querySelectorAll('ul[aria-label="Saved imports"] li button');
}

async function settled(container: HTMLElement, text: string): Promise<void> {
  await vi.waitFor(() => expect(container.textContent).toContain(text));
  await vi.waitFor(() => expect(container.querySelector('[aria-busy="true"]')).toBeNull());
}

it("places import history after Start import and loads only on disclosure expansion", async () => {
  const { container, group, access, trigger, panel, changed } = fixture();
  expect(group.heading).toBe("Import");
  expect(renders(group).map((definition) => definition.name)).toEqual([
    "Start import",
    "Import history",
  ]);
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(panel.hidden).toBe(true);
  expect(panel.inert).toBe(true);
  changed();
  trigger.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  expect(access.history).not.toHaveBeenCalled();
  const start = renderDefinition(requiredRender(renders(group), "Start import"));
  document.body.append(start.container);
  start.container.focus();
  start.container.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  await vi.waitFor(() =>
    expect(access.open).toHaveBeenCalledWith(window, undefined, expect.any(AbortSignal)),
  );
  expect(access.history).not.toHaveBeenCalled();
  trigger.click();
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(panel.hidden).toBe(false);
  expect(panel.inert).toBe(false);
  expect(access.history).toHaveBeenCalledWith(window, expect.any(AbortSignal));
  await settled(container, "No saved imports.");
  await assertAccessibleSemantics(container, ["button-name", "aria-valid-attr-value"]);
  start.cleanup();
});

it("bounds 1000 imports and retains the selected page and focus after returning from details", async () => {
  const { container, access, trigger, changed } = fixture();
  const history = Array.from({ length: 1000 }, (_, index) => journal(index));
  access.history.mockResolvedValue(history);
  trigger.click();
  await settled(container, "1,000 saved imports.");
  expect(rows(container)).toHaveLength(25);
  expect(rows(container)[0]?.textContent).toContain("Import complete · 0 files");
  expect(rows(container)[0]?.textContent).toContain("2026");
  expect(rows(container)[0]?.textContent).not.toContain("run-0");
  const next = button(container, "Next page: Saved imports");
  const previous = button(container, "Previous page: Saved imports");
  expect(previous.disabled).toBe(true);
  for (let page = 1; page < 40; page += 1) {
    next.click();
    expect(rows(container)).toHaveLength(25);
  }
  expect(container.textContent).toContain("976–1,000 of 1,000");
  expect(next.disabled).toBe(true);
  expect(document.activeElement).toBe(previous);
  const last = rows(container)[24]!;
  expect(last.textContent).toContain("Undone · 0 files");
  last.dispatchEvent(new PointerEvent("pointerenter", { pointerType: "mouse" }));
  last.focus();
  last.click();
  await vi.waitFor(() =>
    expect(access.open).toHaveBeenCalledWith(window, history[999], expect.any(AbortSignal)),
  );
  expect(access.history).toHaveBeenCalledOnce();
  const refresh = pendingHistory();
  access.history.mockReturnValueOnce(refresh.promise);
  changed();
  expect(document.activeElement).toBe(last);
  const updated = history.map((entry) => ({ ...entry }));
  updated[999]!.status = "conflict";
  refresh.finish(updated);
  await settled(container, "Needs review");
  expect(container.textContent).toContain("976–1,000 of 1,000");
  expect(rows(container)).toHaveLength(25);
  expect(rows(container)[24]?.textContent).toContain("Needs review · 0 files");
  expect(document.activeElement).toBe(rows(container)[24]);
  button(container, "Previous page: Saved imports").click();
  expect(container.textContent).toContain("951–975 of 1,000");
  expect(access.history).toHaveBeenCalledTimes(2);
});

it("keeps cached rows during refresh and rejects superseded history completions", async () => {
  const { container, access, trigger, changed } = fixture();
  access.history.mockResolvedValueOnce([journal()]);
  trigger.click();
  await settled(container, "1 saved import.");
  const retained = rows(container)[0];
  const stale = pendingHistory();
  const current = pendingHistory();
  access.history.mockReturnValueOnce(stale.promise).mockReturnValueOnce(current.promise);
  changed();
  const supersededSignal = access.history.mock.calls[1]![1];
  expect(container.textContent).toContain("Loading import history");
  expect(rows(container)[0]).toBe(retained);
  changed();
  expect(supersededSignal.aborted).toBe(true);
  current.finish([journal(999)]);
  await settled(container, "Undone");
  stale.finish([]);
  await stale.promise;
  expect(rows(container)).toHaveLength(1);
  expect(container.textContent).toContain("Undone");
  expect(container.textContent).not.toContain("No saved imports");
});

it("announces a failed load without private details and retries to the empty state", async () => {
  const { container, access, trigger } = fixture();
  access.history.mockRejectedValueOnce(new Error("private vault content"));
  trigger.click();
  await settled(container, "Import history could not be loaded");
  expect(container.querySelector('[role="status"]')?.textContent).toContain("try again");
  expect(container.textContent).not.toContain("private vault content");
  const pending = pendingHistory();
  access.history.mockReturnValueOnce(pending.promise);
  const retry = button(container, "Try again");
  retry.focus();
  retry.click();
  expect(container.textContent).toContain("Loading import history");
  expect(document.activeElement).toBe(retry);
  retry.click();
  expect(access.history).toHaveBeenCalledTimes(2);
  pending.finish([]);
  await settled(container, "No saved imports.");
  expect(rows(container)).toHaveLength(0);
  expect(container.textContent).not.toContain("Try again");
  expect(document.activeElement).toBe(trigger);
  expect(access.history).toHaveBeenCalledTimes(2);
});

it("cancels collapsed requests and never publishes their late results after reopening", async () => {
  const { container, access, trigger, panel, changed } = fixture();
  const pending = pendingHistory();
  access.history.mockReturnValueOnce(pending.promise).mockResolvedValueOnce([journal(999)]);
  trigger.click();
  const signal = access.history.mock.calls[0]![1];
  expect(container.textContent).toContain("Loading import history");
  trigger.click();
  expect(signal.aborted).toBe(true);
  expect(panel.hidden).toBe(true);
  expect(panel.inert).toBe(true);
  changed();
  expect(access.history).toHaveBeenCalledOnce();
  trigger.click();
  await settled(container, "Undone");
  pending.finish([]);
  await pending.promise;
  expect(rows(container)).toHaveLength(1);
  expect(container.textContent).not.toContain("No saved imports");
});

it("releases pending requests and subscriptions on disposal, owner abort and pagehide", async () => {
  for (const ending of ["dispose", "abort", "pagehide"] as const) {
    const owner = new AbortController();
    const { container, access, trigger, cleanup, changed, listenerCount } = fixture(owner.signal);
    const pending = pendingHistory();
    access.history.mockReturnValueOnce(pending.promise);
    trigger.click();
    const signal = access.history.mock.calls[0]![1];
    if (ending === "dispose") cleanup();
    else if (ending === "abort") owner.abort();
    else window.dispatchEvent(new Event("pagehide"));
    expect(signal.aborted).toBe(true);
    expect(listenerCount()).toBe(0);
    changed();
    trigger.click();
    pending.finish([journal()]);
    await pending.promise;
    expect(rows(container)).toHaveLength(0);
    expect(access.history).toHaveBeenCalledOnce();
    cleanup();
    container.remove();
  }
});

it("restores the expanded history and page after locale redisplay without rereading journals", async () => {
  const state: ImportHistoryState = {};
  const first = fixture(undefined, state);
  first.access.history.mockResolvedValueOnce(
    Array.from({ length: 60 }, (_, index) => journal(index)),
  );
  first.trigger.click();
  await settled(first.container, "60 saved imports.");
  button(first.container, "Next page: Saved imports").click();
  expect(first.container.textContent).toContain("26–50 of 60");
  first.cleanup();
  first.container.remove();
  const second = fixture(undefined, state, "de");
  await settled(second.container, "60 gespeicherte Importe.");
  expect(second.trigger.getAttribute("aria-expanded")).toBe("true");
  expect(second.container.textContent).toContain("26–50 von 60");
  expect(second.access.history).not.toHaveBeenCalled();
  second.changed();
  await settled(second.container, "Keine gespeicherten Importe.");
  expect(second.access.history).toHaveBeenCalledTimes(1);
});
