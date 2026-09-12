import { type Plugin } from "obsidian";
import { Notice, Platform, TFile } from "../../../adapters/obsidian/plugin";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { registerPhoneSheetDiagnostics } from "../../../../src/obsidian/diagnostics/phone-sheet-diagnostics";
import { installPhoneSheetDiagnostics } from "../../../../src/obsidian/menus/phone-sheet-diagnostics";

vi.mock("../../../../src/obsidian/menus/phone-sheet-diagnostics", () => ({
  installPhoneSheetDiagnostics: vi.fn(() => vi.fn()),
}));
const CONFIG_PATH = "Inkbook diagnostics/swipe-config.md";
const install = vi.mocked(installPhoneSheetDiagnostics);
const report = {} as Parameters<Parameters<typeof installPhoneSheetDiagnostics>[1]["complete"]>[0];

function setup() {
  const cleanups: Array<() => void> = [];
  const events = new Map<string, (file: TFile) => void>();
  let ready = () => {};
  let stored: unknown;
  const files = new Map<string, TFile>();
  const read = vi.fn(async () =>
    JSON.stringify({ version: 1, id: "phone-test", expiresAt: Date.now() + 60_000, maxReports: 3 }),
  );
  const create = vi.fn(async (path: string, _text: string) => {
    files.set(path, new TFile(path));
  });
  const modify = vi.fn(async (_file: TFile, _text: string) => {});
  const save = vi.fn((_key: string, value: unknown) => {
    stored = value;
  });
  const load = vi.fn(() => stored);
  const plugin = {
    manifest: { version: "1.0.0" },
    register: (callback: () => void) => {
      cleanups.push(callback);
    },
    registerEvent: vi.fn(),
    app: {
      saveLocalStorage: save,
      loadLocalStorage: load,
      workspace: {
        containerEl: {
          ownerDocument: {
            defaultView: {
              setTimeout: setTimeout,
              clearTimeout: clearTimeout,
            },
          },
        },
        onLayoutReady: (callback: () => void) => {
          ready = callback;
        },
      },
      vault: {
        getAbstractFileByPath: (path: string) => files.get(path),
        read,
        create,
        modify,
        on: (event: string, callback: (file: TFile) => void) => {
          events.set(event, callback);
          return {};
        },
      },
    },
  } as unknown as Plugin;
  files.set(CONFIG_PATH, new TFile(CONFIG_PATH));
  registerPhoneSheetDiagnostics(plugin);
  return {
    files,
    read,
    create,
    modify,
    save,
    load,
    ready: () => {
      ready();
    },
    event: (event: string, path = CONFIG_PATH) => {
      events.get(event)?.(new TFile(path));
    },
    unload: () => {
      cleanups.forEach((callback) => {
        callback();
      });
    },
  };
}

function traceCreates(fixture: ReturnType<typeof setup>) {
  return fixture.create.mock.calls.filter(([path]) => path.includes("swipe-trace-"));
}

function statusWrites(fixture: ReturnType<typeof setup>): unknown[] {
  return [
    ...fixture.create.mock.calls.map(([path, text]) => [path, text] as const),
    ...fixture.modify.mock.calls.map(([file, text]) => [file.path, text] as const),
  ]
    .filter(([path]) => path.endsWith("swipe-status.md"))
    .map(([, text]) => JSON.parse(text.slice(8, -5)) as unknown);
}

function deferConfigurationRead(fixture: ReturnType<typeof setup>): (text: string) => void {
  let resolve!: (text: string) => void;
  fixture.read.mockImplementationOnce(
    () =>
      new Promise<string>((done) => {
        resolve = done;
      }),
  );
  return (text) => {
    resolve(text);
  };
}

async function activate(fixture: ReturnType<typeof setup>) {
  fixture.ready();
  await settle();
  return callbacks();
}

async function settle() {
  for (let index = 0; index < 50; index += 1) await Promise.resolve();
}
function callbacks() {
  return install.mock.calls[install.mock.calls.length - 1]![1];
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  Platform.isPhone = true;
  Notice.instances.length = 0;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  Platform.isPhone = false;
});

describe("phone sheet diagnostic registration", () => {
  it("does not activate on desktop or tablet", async () => {
    Platform.isPhone = false;
    const fixture = setup();
    fixture.ready();
    await settle();
    expect(fixture.read).not.toHaveBeenCalled();
    expect(install).not.toHaveBeenCalled();
  });

  it("is disabled when the marker is absent and ignores unrelated events", async () => {
    const fixture = setup();
    fixture.files.clear();
    fixture.ready();
    await settle();
    fixture.event("modify", "other.json");
    await settle();
    expect(install).not.toHaveBeenCalled();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it.each([
    "null",
    "{}",
    "broken",
    JSON.stringify({ version: 1, id: "../private", expiresAt: Date.now() + 1000, maxReports: 3 }),
    JSON.stringify({ version: 1, id: "test", expiresAt: 0, maxReports: 3 }),
    JSON.stringify({ version: 1, id: "test", expiresAt: Date.now() + 8 * 86400000, maxReports: 3 }),
    " ".repeat(1025),
  ])("rejects invalid configuration %s", async (value) => {
    const fixture = setup();
    fixture.read.mockResolvedValue(value);
    fixture.ready();
    await settle();
    expect(install).not.toHaveBeenCalled();
  });

  it("rejects oversized files before reading", async () => {
    const fixture = setup();
    fixture.files.set(CONFIG_PATH, new TFile(CONFIG_PATH, 1025));
    fixture.ready();
    await settle();
    expect(fixture.read).not.toHaveBeenCalled();
  });

  it("writes three sequential bounded reports and persists the claim before completion", async () => {
    const fixture = setup();
    const capture = await activate(fixture);
    for (let index = 1; index <= 3; index += 1) {
      expect(capture.claim()).toBe(true);
      expect(fixture.save).toHaveBeenLastCalledWith("inkbook:phone-sheet-diagnostics", {
        id: "phone-test",
        count: index,
      });
      capture.complete(report);
    }
    expect(capture.claim()).toBe(false);
    await settle();
    expect(traceCreates(fixture).map(([path]) => path)).toEqual(
      [1, 2, 3].map((index) => `Inkbook diagnostics/swipe-trace-${String(index)}.md`),
    );
    const markdown = traceCreates(fixture)[0]![1];
    expect(markdown.startsWith("```json\n")).toBe(true);
    expect(markdown.endsWith("\n```\n")).toBe(true);
    expect(JSON.parse(markdown.slice(8, -5))).toMatchObject({
      configId: "phone-test",
      pluginVersion: "1.0.0",
      report: {},
    });
    fixture.event("modify");
    await settle();
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("reuses the active recorder and overwrites an existing trace", async () => {
    const fixture = setup();
    fixture.files.set(
      "Inkbook diagnostics/swipe-trace-1.md",
      new TFile("Inkbook diagnostics/swipe-trace-1.md"),
    );
    fixture.ready();
    await settle();
    fixture.event("modify");
    await settle();
    expect(install).toHaveBeenCalledTimes(1);
    expect(callbacks().claim()).toBe(true);
    callbacks().complete(report);
    await settle();
    expect(
      fixture.modify.mock.calls.filter(([file]) => file.path.includes("swipe-trace-")),
    ).toHaveLength(1);
    expect(traceCreates(fixture)).toHaveLength(0);
  });
});

describe("phone sheet diagnostic lifecycle", () => {
  it("stops on expiry and unload without starting queued writes", async () => {
    const fixture = setup();
    const capture = await activate(fixture);
    expect(capture.claim()).toBe(true);
    capture.complete(report);
    fixture.unload();
    await settle();
    expect(traceCreates(fixture)).toHaveLength(0);
    expect(capture.claim()).toBe(false);
    expect(install.mock.results[0]!.value).toHaveBeenCalledOnce();
  });

  it("expires an idle recorder", async () => {
    const fixture = setup();
    const capture = await activate(fixture);
    vi.advanceTimersByTime(60_000);
    expect(capture.claim()).toBe(false);
    expect(install.mock.results[0]!.value).toHaveBeenCalledOnce();
  });

  it("coalesces concurrent marker loads and ignores a pending load after unload", async () => {
    const fixture = setup();
    const resolve = deferConfigurationRead(fixture);
    fixture.ready();
    fixture.event("create");
    fixture.event("modify");
    expect(fixture.read).toHaveBeenCalledTimes(1);
    fixture.unload();
    resolve("{}");
    await settle();
    expect(install).not.toHaveBeenCalled();
    expect(fixture.read).toHaveBeenCalledTimes(1);
  });

  it("fails closed for unavailable device storage and handles write rejection", async () => {
    const fixture = setup();
    fixture.ready();
    await settle();
    fixture.save.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    expect(callbacks().claim()).toBe(false);
    expect(callbacks().claim()).toBe(true);
    fixture.create.mockRejectedValueOnce(new Error("read only"));
    callbacks().complete(report);
    await settle();
    expect(Notice.instances).toHaveLength(1);
  });

  it("stops recording if the marker is deleted or unreadable", async () => {
    const fixture = setup();
    fixture.ready();
    await settle();
    fixture.files.clear();
    fixture.event("delete");
    await settle();
    expect(install.mock.results[0]!.value).toHaveBeenCalledOnce();
    fixture.files.set(CONFIG_PATH, new TFile(CONFIG_PATH));
    fixture.read.mockRejectedValueOnce(new Error("missing"));
    fixture.event("create");
    await settle();
    expect(install).toHaveBeenCalledTimes(1);
  });
});

describe("phone sheet diagnostic limits", () => {
  it("resumes the stored device budget and clamps a larger requested budget", async () => {
    const fixture = setup();
    fixture.load.mockReturnValue({ id: "phone-test", count: 2 });
    fixture.read.mockResolvedValue(
      JSON.stringify({
        version: 1,
        id: "phone-test",
        expiresAt: Date.now() + 1000,
        maxReports: 90,
      }),
    );
    fixture.ready();
    await settle();
    expect(callbacks().claim()).toBe(true);
    callbacks().complete(report);
    await settle();
    expect(traceCreates(fixture)[0]?.[0]).toBe("Inkbook diagnostics/swipe-trace-3.md");
    expect(callbacks().claim()).toBe(false);
  });

  it("does not record with corrupt or inaccessible matching device state", async () => {
    const fixture = setup();
    fixture.load.mockReturnValue({ id: "phone-test", count: -2 });
    fixture.ready();
    await settle();
    expect(install).not.toHaveBeenCalled();
    fixture.load.mockImplementationOnce(() => {
      throw new Error("unavailable");
    });
    fixture.event("modify");
    await settle();
    expect(install).not.toHaveBeenCalled();
  });

  it("starts a new budget for a different configuration id", async () => {
    const fixture = setup();
    fixture.load.mockReturnValue({ id: "old", count: 3 });
    fixture.ready();
    await settle();
    expect(callbacks().claim()).toBe(true);
  });

  it("serializes writes and lets only an already started write finish on unload", async () => {
    const fixture = setup();
    let resolve!: () => void;
    fixture.ready();
    await settle();
    fixture.create.mockClear();
    fixture.create.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    const capture = callbacks();
    expect(capture.claim()).toBe(true);
    capture.complete(report);
    await settle();
    expect(capture.claim()).toBe(true);
    capture.complete(report);
    await settle();
    expect(fixture.create).toHaveBeenCalledTimes(1);
    fixture.unload();
    resolve();
    await settle();
    expect(fixture.create).toHaveBeenCalledTimes(1);
  });

  it("performs one follow-up read for multiple events during a pending read", async () => {
    const fixture = setup();
    const resolve = deferConfigurationRead(fixture);
    fixture.ready();
    fixture.event("modify");
    fixture.event("create");
    resolve("{}");
    await settle();
    expect(fixture.read).toHaveBeenCalledTimes(2);
    expect(install).toHaveBeenCalledTimes(1);
  });

  it("handles recorder installation failure without an unhandled rejection", async () => {
    install.mockImplementationOnce(() => {
      throw new Error("closed document");
    });
    const fixture = setup();
    fixture.ready();
    await settle();
    expect(statusWrites(fixture)).toEqual([expect.objectContaining({ state: "recorder-error" })]);
    fixture.event("modify");
    await settle();
    expect(install).toHaveBeenCalledTimes(2);
  });
});

describe("phone sheet diagnostic status", () => {
  it("confirms successful recorder activation without needing a gesture", async () => {
    const fixture = setup();
    fixture.ready();
    await settle();
    expect(statusWrites(fixture)).toEqual([
      expect.objectContaining({
        state: "ready",
        configId: "phone-test",
        platform: "phone",
        diagnosticBuild: "phone-sheet-status-v1",
        claims: 0,
        reportNumber: null,
      }),
    ]);
    expect(traceCreates(fixture)).toHaveLength(0);
    fixture.event("modify");
    await settle();
    expect(statusWrites(fixture)).toHaveLength(1);
  });

  it("reports an exhausted budget independently of recorder installation", async () => {
    const fixture = setup();
    fixture.load.mockReturnValue({ id: "phone-test", count: 3 });
    fixture.ready();
    await settle();
    expect(install).not.toHaveBeenCalled();
    expect(statusWrites(fixture)).toEqual([
      expect.objectContaining({ state: "budget-exhausted", claims: 3 }),
    ]);
  });

  it("updates status after a report succeeds or fails", async () => {
    const fixture = setup();
    const capture = await activate(fixture);
    expect(capture.claim()).toBe(true);
    capture.complete(report);
    await settle();
    expect(statusWrites(fixture)[1]).toMatchObject({
      state: "report-saved",
      claims: 1,
      reportNumber: 1,
    });
    fixture.create.mockRejectedValueOnce(new Error("read only"));
    expect(capture.claim()).toBe(true);
    capture.complete(report);
    await settle();
    expect(statusWrites(fixture)[2]).toMatchObject({
      state: "write-error",
      claims: 2,
      reportNumber: 2,
    });
  });

  it("does not let a stale report overwrite a newer configuration status", async () => {
    const fixture = setup();
    fixture.ready();
    await settle();
    let resolve!: () => void;
    fixture.create.mockImplementationOnce(
      () =>
        new Promise<void>((done) => {
          resolve = done;
        }),
    );
    expect(callbacks().claim()).toBe(true);
    callbacks().complete(report);
    await settle();
    fixture.read.mockResolvedValue(
      JSON.stringify({ version: 1, id: "new", expiresAt: Date.now() + 1000, maxReports: 3 }),
    );
    fixture.event("modify");
    await settle();
    resolve();
    await settle();
    expect(statusWrites(fixture)).toEqual([
      expect.objectContaining({ configId: "phone-test", state: "ready" }),
      expect.objectContaining({ configId: "new", state: "ready" }),
    ]);
  });
});

it("preserves queued final reports when the same marker is reloaded", async () => {
  const fixture = setup();
  fixture.read.mockResolvedValue(
    JSON.stringify({ version: 1, id: "phone-test", expiresAt: Date.now() + 1000, maxReports: 1 }),
  );
  const capture = await activate(fixture);
  expect(capture.claim()).toBe(true);
  capture.complete(report);
  fixture.event("modify");
  await settle();
  expect(traceCreates(fixture)).toHaveLength(1);
  expect(statusWrites(fixture)[1]).toMatchObject({ state: "report-saved", reportNumber: 1 });
});
