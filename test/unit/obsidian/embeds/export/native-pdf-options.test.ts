// @vitest-environment happy-dom

import type { App, MarkdownView } from "obsidian";
import { afterEach, expect, it, vi } from "vitest";
import { NativePdfOptionsGateway } from "../../../../../src/obsidian/embeds/export/native-pdf-options";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

function gatewayFixture() {
  type Listener = (value?: unknown) => void;
  const listeners = new Map<string, Set<Listener>>();
  const on = (name: string, listener: Listener) => {
    const entries = listeners.get(name) ?? new Set<Listener>();
    entries.add(listener);
    listeners.set(name, entries);
    return { name, listener };
  };
  const offref = ({ name, listener }: { name: string; listener: Listener }) =>
    listeners.get(name)?.delete(listener);
  const containerEl = document.createElementNS("http://www.w3.org/1999/xhtml", "div");
  document.body.append(containerEl);
  const view = { containerEl, file: { path: "note.md" } } as unknown as MarkdownView;
  const options = {
    pageSize: "A4",
    landscape: false,
    margin: "0",
    downscalePercent: 75,
  };
  const getConfig = vi.fn(() => structuredClone(options) as unknown);
  const host = { active: view };
  const app = {
    vault: { getConfig, on, offref },
    workspace: { getActiveViewOfType: () => host.active, on, offref },
  } as unknown as App;
  const gateway = new NativePdfOptionsGateway(app);
  const emit = (name: string, value?: unknown) => {
    for (const listener of listeners.get(name) ?? []) listener(value);
  };
  return { gateway, host, view, options, getConfig, emit, listeners };
}

function exportTarget(source: Window = window, timeOrigin = Date.now() + 1000) {
  const targetDocument = document.implementation.createHTMLDocument("Native export");
  const target = {
    opener: source,
    closed: false,
    location: { href: "about:blank" },
    performance: { timeOrigin },
  };
  Object.defineProperty(targetDocument, "defaultView", { value: target });
  const root = targetDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  targetDocument.body.append(root);
  return { root, targetDocument, target };
}

function bindNextExport(fixture: ReturnType<typeof gatewayFixture>) {
  fixture.emit("config-changed", "pdfExportSettings");
  return fixture.gateway.bind(exportTarget().root, "note.md");
}

it("never applies saved preferences without a fresh native options event", () => {
  const add = vi.spyOn(window, "addEventListener");
  const fixture = gatewayFixture();
  try {
    expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
    expect(add).not.toHaveBeenCalled();
    fixture.emit("config-changed", "unrelated");
    expect(fixture.getConfig).not.toHaveBeenCalled();
    expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
  } finally {
    fixture.gateway.dispose();
  }
});

it("keeps concurrent source-window tickets separate and snapshots their respective native options", () => {
  const fixture = gatewayFixture();
  const secondDocument = document.implementation.createHTMLDocument("Other source");
  const secondWindow = Object.assign(new EventTarget(), {
    closed: false,
    performance: { timeOrigin: 0, now: () => Date.now() },
  }) as unknown as Window;
  Object.defineProperty(secondDocument, "defaultView", { value: secondWindow });
  const containerEl = secondDocument.createElementNS("http://www.w3.org/1999/xhtml", "div");
  secondDocument.body.append(containerEl);
  try {
    fixture.emit("config-changed", "pdfExportSettings");
    fixture.host.active = { containerEl, file: { path: "other.md" } } as unknown as MarkdownView;
    fixture.options.downscalePercent = 50;
    fixture.emit("config-changed", "pdfExportSettings");
    expect(fixture.gateway.bind(exportTarget().root, "note.md")?.scale).toBe(0.75);
    expect(fixture.gateway.bind(exportTarget(secondWindow).root, "other.md")?.scale).toBe(0.5);
  } finally {
    fixture.gateway.dispose();
  }
});

it("binds one fresh target and freezes options independently of later host settings", () => {
  const fixture = gatewayFixture();
  try {
    fixture.emit("config-changed", "pdfExportSettings");
    const output = exportTarget();
    const options = fixture.gateway.bind(output.root, "note.md");
    expect(options).toEqual({ scale: 0.75, pageSize: "A4", landscape: false, margin: "0" });
    fixture.options.downscalePercent = 50;
    expect(Object.isFrozen(options)).toBe(true);
    expect(fixture.gateway.bind(output.root, "note.md")).toBe(options);
    expect(fixture.gateway.bind(output.root, "other.md")).toBeUndefined();
    expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
    expect(fixture.getConfig).toHaveBeenCalledExactlyOnceWith("pdfExportSettings");
    expect(fixture.listeners.get("config-changed")?.size).toBe(1);
  } finally {
    fixture.gateway.dispose();
  }
});

it.each(["pointerdown", "keydown"] as const)(
  "drops a cancelled export ticket at the next source %s and removes its listeners",
  (event) => {
    const fixture = gatewayFixture();
    const remove = vi.spyOn(window, "removeEventListener");
    try {
      fixture.emit("config-changed", "pdfExportSettings");
      window.dispatchEvent(new Event(event));
      expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
      const removals = remove.mock.calls.length;
      window.dispatchEvent(new Event(event));
      expect(remove).toHaveBeenCalledTimes(removals);
      expect(remove.mock.calls.map(([name]) => name)).toEqual(["pointerdown", "keydown", "unload"]);
    } finally {
      fixture.gateway.dispose();
    }
  },
);

it("allows a later export with identical option values while rejecting main and old targets", () => {
  const fixture = gatewayFixture();
  try {
    fixture.emit("config-changed", "pdfExportSettings");
    expect(fixture.gateway.bind(exportTarget(window, 0).root, "note.md")).toBeUndefined();
    expect(fixture.gateway.bind(fixture.view.containerEl, "note.md")).toBeUndefined();
    expect(fixture.gateway.bind(exportTarget().root, "other.md")).toBeUndefined();
    expect(fixture.gateway.bind(exportTarget().root, "note.md")?.scale).toBe(0.75);
    expect(bindNextExport(fixture)?.scale).toBe(0.75);
  } finally {
    fixture.gateway.dispose();
  }
});

it.each(["file-open", "active-leaf-change"])("invalidates tickets after %s", (event) => {
  const fixture = gatewayFixture();
  try {
    fixture.emit("config-changed", "pdfExportSettings");
    if (event === "file-open") fixture.view.file!.path = "other.md";
    else fixture.host.active = { ...fixture.view, file: { path: "other.md" } } as MarkdownView;
    fixture.emit(event, { view: fixture.host.active });
    expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
  } finally {
    fixture.gateway.dispose();
  }
});

it("rejects a closed source view and releases its pending input ownership", () => {
  const fixture = gatewayFixture();
  try {
    fixture.emit("config-changed", "pdfExportSettings");
    fixture.view.containerEl.remove();
    fixture.emit("active-leaf-change", null);
    expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
  } finally {
    fixture.gateway.dispose();
  }
});

it("leaves foreign and navigated popup documents untouched without consuming the native ticket", () => {
  const fixture = gatewayFixture();
  try {
    fixture.emit("config-changed", "pdfExportSettings");
    const output = exportTarget();
    output.target.location.href = "https://example.invalid/";
    expect(fixture.gateway.bind(output.root, "note.md")).toBeUndefined();
    const foreign = exportTarget({} as Window);
    expect(fixture.gateway.bind(foreign.root, "note.md")).toBeUndefined();
    expect(fixture.gateway.bind(exportTarget().root, "note.md")?.scale).toBe(0.75);
  } finally {
    fixture.gateway.dispose();
  }
});

it("fails closed when the private option read throws and recovers on a later native export", () => {
  const fixture = gatewayFixture();
  try {
    fixture.getConfig.mockImplementationOnce(() => {
      throw new Error("Native PDF options are unavailable.");
    });
    fixture.emit("config-changed", "pdfExportSettings");
    expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
    expect(bindNextExport(fixture)?.scale).toBe(0.75);
  } finally {
    fixture.gateway.dispose();
  }
});

it.each([
  null,
  { pageSize: "unknown" },
  { downscalePercent: 0 },
  { downscalePercent: 75.5 },
  { margin: "3" },
])("rejects unavailable or unsupported native settings %j", (invalid) => {
  const fixture = gatewayFixture();
  try {
    fixture.getConfig.mockReturnValue(invalid === null ? null : { ...fixture.options, ...invalid });
    fixture.emit("config-changed", "pdfExportSettings");
    expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
  } finally {
    fixture.gateway.dispose();
  }
});

it("disposes pending input ownership and host subscriptions without accepting later targets", () => {
  const fixture = gatewayFixture();
  fixture.emit("config-changed", "pdfExportSettings");
  fixture.gateway.dispose();
  expect([...fixture.listeners.values()].every((listeners) => listeners.size === 0)).toBe(true);
  fixture.emit("config-changed", "pdfExportSettings");
  expect(fixture.gateway.bind(exportTarget().root, "note.md")).toBeUndefined();
});
