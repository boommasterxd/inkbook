// @vitest-environment happy-dom
import type { TFile as ObsidianFile } from "obsidian";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { PenDiagnosticSession } from "../../../../src/obsidian/diagnostics/pen-diagnostic-session";
import { TFile, TFolder } from "../../../adapters/obsidian/plugin";

function fixture() {
  let markdown = "";
  const vault = {
    getAbstractFileByPath: vi.fn(() => null as TFile | TFolder | null),
    createFolder: vi.fn(async () => new TFolder("Inkbook Diagnostics")),
    create: vi.fn(async (path: string, content: string) => {
      markdown = content;
      return new TFile(path) as unknown as ObsidianFile;
    }),
    append: vi.fn(async (_file: ObsidianFile, content: string) => {
      markdown += content;
    }),
  };
  const notify = vi.fn();
  const session = new PenDiagnosticSession({
    vault: vault as unknown as ConstructorParameters<typeof PenDiagnosticSession>[0]["vault"],
    ownerWindow: window,
    pluginVersion: "1.2.3",
    obsidianVersion: "1.9.0",
    notify,
  });
  session.addWindow(window);
  return { session, vault, notify, markdown: () => markdown };
}

function emit(type = "pointermove"): void {
  window.dispatchEvent(new PointerEvent(type, { pointerType: "pen", buttons: 2, pressure: 0 }));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("PenDiagnosticSession", () => {
  it("creates a bounded environment header and saves complete incremental Markdown batches", async () => {
    vi.spyOn(window.navigator, "userAgent", "get").mockReturnValue("a".repeat(900));
    const { session, vault, markdown } = fixture();
    expect(session.canStart).toBe(true);
    await session.start();
    expect(vault.createFolder).toHaveBeenCalledOnce();
    expect(vault.create.mock.calls[0]?.[0]).toMatch(/^Inkbook Diagnostics\/pen-input-.*\.md$/u);
    const header = markdown();
    expect(header).toContain('"pluginVersion": "1.2.3"');
    expect(header).toContain('"obsidianVersion": "1.9.0"');
    emit();
    await vi.advanceTimersByTimeAsync(4_999);
    expect(vault.append).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(vault.append).toHaveBeenCalledOnce();
    expect(markdown()).toContain("a".repeat(512));
    expect(markdown()).not.toContain("a".repeat(513));
    expect(markdown()).toContain('"type":"pointermove"');
    expect(markdown().match(/^```/gmu)).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(vault.append).toHaveBeenCalledOnce();
    emit("pointerup");
    await session.stop();
    expect(markdown()).toContain('"type":"pointerup"');
    expect(markdown()).toContain("Captured events: 3.");
    expect(markdown().match(/^```/gmu)).toHaveLength(6);
    expect(session.canStart).toBe(true);
    session.dispose();
  });

  it("retains failed batches and subsequent events for an explicit save retry", async () => {
    const { session, vault, markdown, notify } = fixture();
    await session.start();
    vault.append.mockRejectedValueOnce(new Error("offline"));
    emit();
    await vi.advanceTimersByTimeAsync(5_000);
    const failedBatch = vault.append.mock.calls[0]?.[1];
    expect(session.canStop).toBe(true);
    expect(session.canStart).toBe(false);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("saving failed"));
    emit("pointerup");
    await session.stop();
    expect(vault.append.mock.calls[1]?.[1]).toBe(failedBatch);
    expect(markdown()).toContain('"type":"pointermove"');
    expect(markdown()).not.toContain('"type":"pointerup"');
    expect(markdown()).toContain("Captured events: 2.");
    session.dispose();
  });
});

describe("PenDiagnosticSession pending writes", () => {
  it.each(["stop", "dispose"])(
    "serializes %s with a pending write and preserves the final buffer",
    async (action) => {
      const { session, vault, markdown } = fixture();
      await session.start();
      const originalAppend = vault.append.getMockImplementation();
      let release: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      vault.append.mockImplementationOnce(async (file, content) => {
        await pending;
        await originalAppend?.(file, content);
      });
      emit();
      await vi.advanceTimersByTimeAsync(5_000);
      emit("pointerup");
      if (action === "dispose") session.dispose();
      const stopping = session.stop();
      expect(session.stop()).toBe(stopping);
      expect(vault.append).toHaveBeenCalledOnce();
      release();
      await stopping;
      expect(vault.append).toHaveBeenCalledTimes(3);
      expect(markdown()).toContain('"type":"pointermove"');
      expect(markdown()).toContain('"type":"pointerup"');
      expect(markdown()).toContain("Captured events: 3.");
      expect(markdown()).toContain(`Reason: ${action === "dispose" ? "plugin-unload" : "manual"}.`);
      await vi.advanceTimersByTimeAsync(120_000);
      expect(vault.append).toHaveBeenCalledTimes(3);
      expect(vi.getTimerCount()).toBe(0);
      session.dispose();
    },
  );
});

describe("PenDiagnosticSession lifecycle", () => {
  it("finishes a file creation that resolves after disposal", async () => {
    const { session, vault, markdown } = fixture();
    const originalCreate = vault.create.getMockImplementation();
    let release: () => void = () => undefined;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    vault.create.mockImplementationOnce(async (path, content) => {
      await pending;
      if (originalCreate === undefined) throw new Error("Missing create mock");
      return originalCreate(path, content);
    });
    const starting = session.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(vault.create).toHaveBeenCalledOnce();
    session.dispose();
    release();
    await starting;
    await session.stop();
    expect(session.canStart).toBe(false);
    expect(session.canStop).toBe(false);
    expect(markdown()).toContain("Reason: plugin-unload.");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops automatically at 120 seconds and ignores events after the deadline", async () => {
    const { session, markdown } = fixture();
    await session.start();
    await vi.advanceTimersByTimeAsync(119_999);
    expect(session.canStart).toBe(false);
    emit();
    await vi.advanceTimersByTimeAsync(1);
    emit("pointerup");
    expect(session.canStart).toBe(true);
    expect(markdown()).toContain("Reason: time-limit.");
    expect(markdown()).toContain("Captured events: 2.");
    expect(markdown()).not.toContain('"type":"pointerup"');
    session.dispose();
  });

  it("handles duplicate starts, an existing folder, and repeated inactive stops", async () => {
    const { session, vault } = fixture();
    vault.getAbstractFileByPath.mockReturnValue(new TFolder("Inkbook Diagnostics"));
    await Promise.all([session.start(), session.start()]);
    expect(vault.create).toHaveBeenCalledOnce();
    expect(vault.createFolder).not.toHaveBeenCalled();
    await session.start();
    expect(vault.create).toHaveBeenCalledOnce();
    await session.stop();
    await session.stop();
    expect(vault.append).toHaveBeenCalledTimes(2);
    session.dispose();
  });
});

describe("PenDiagnosticSession stopping during startup", () => {
  it.each(["folder", "file"])(
    "awaits pending %s creation and final save without capturing",
    async (boundary) => {
      const { session, vault, markdown, notify } = fixture();
      let release: () => void = () => undefined;
      const pending = new Promise<void>((resolve) => {
        release = resolve;
      });
      if (boundary === "folder") {
        vault.createFolder.mockImplementationOnce(async () => {
          await pending;
          return new TFolder("Inkbook Diagnostics");
        });
      } else {
        const create = vault.create.getMockImplementation();
        vault.create.mockImplementationOnce(async (path, content) => {
          await pending;
          if (create === undefined) throw new Error("Missing create mock");
          return create(path, content);
        });
      }
      const starting = session.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(session.canStop).toBe(true);
      let stopped = false;
      const stopping = session.stop("quit").then(() => {
        stopped = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(stopped).toBe(false);
      emit();
      release();
      await Promise.all([starting, stopping]);
      expect(markdown()).toContain("Reason: quit. Captured events: 0.");
      expect(notify).not.toHaveBeenCalledWith(expect.stringContaining("started"));
      expect(session.canStart).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      session.dispose();
    },
  );
});

describe("PenDiagnosticSession failure and cleanup", () => {
  it.each(["folder", "create"])("recovers from %s creation failure", async (boundary) => {
    const { session, vault, notify } = fixture();
    if (boundary === "folder")
      vault.getAbstractFileByPath.mockReturnValueOnce(new TFile("Inkbook Diagnostics"));
    else vault.create.mockRejectedValueOnce(new Error("permission denied"));
    await session.start();
    expect(session.canStart).toBe(true);
    expect(session.canStop).toBe(false);
    expect(notify).toHaveBeenLastCalledWith(expect.stringContaining("Could not start"));
    await session.start();
    expect(session.canStop).toBe(true);
    await session.stop();
    session.dispose();
  });

  it("keeps an unsaved final marker retryable", async () => {
    const { session, vault, markdown } = fixture();
    await session.start();
    vault.append.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error("disk full"));
    await session.stop();
    expect(session.canStop).toBe(true);
    await session.stop();
    expect(session.canStart).toBe(true);
    expect(markdown()).toContain("Reason: manual.");
    session.dispose();
  });

  it("flushes on disposal and releases listeners and timers", async () => {
    const { session, vault, markdown } = fixture();
    await session.start();
    emit();
    session.dispose();
    await session.stop();
    expect(markdown()).toContain("Reason: plugin-unload.");
    expect(markdown()).toContain("Captured events: 2.");
    const writes = vault.append.mock.calls.length;
    emit();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(vault.append).toHaveBeenCalledTimes(writes);
    expect(vi.getTimerCount()).toBe(0);
    expect(session.canStart).toBe(false);
  });
});
