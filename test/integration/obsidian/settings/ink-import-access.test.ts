// @vitest-environment happy-dom
import "../../../fixtures/obsidian/menu-motion";

import { Keymap, type App } from "obsidian";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import type { InkImportJournal, InkImportPreview } from "../../../../src/obsidian/import/types";
import { InkImportAccess } from "../../../../src/obsidian/settings/import/import-access";
import type { InkImportDialogOptions } from "../../../../src/obsidian/settings/import/ink-import-dialog";
import { installObsidianDomHelpers } from "../../../adapters/obsidian/dom";
import { dialogButton } from "../../../fixtures/obsidian/dialog";
import { workSchedulerFromFrames } from "../../../fixtures/obsidian/work-scheduler";

const owners: AbortController[] = [];

beforeEach(installObsidianDomHelpers);
afterEach(() => {
  for (const owner of owners.splice(0)) owner.abort();
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

function journal(): InkImportJournal {
  return {
    version: 1,
    id: "saved-run",
    createdAt: "2026-10-29",
    status: "complete",
    sources: [],
    notes: [],
    issues: [],
  };
}

function fixture() {
  const owner = new AbortController();
  owners.push(owner);
  const service = {
    scan: vi.fn<InkImportDialogOptions["service"]["scan"]>(),
    apply: vi.fn<InkImportDialogOptions["service"]["apply"]>(),
    history: vi.fn<InkImportDialogOptions["service"]["history"]>().mockResolvedValue([journal()]),
    undo: vi.fn<InkImportDialogOptions["service"]["undo"]>(),
    cleanup: vi.fn<InkImportDialogOptions["service"]["cleanup"]>(),
  };
  const createService = vi.fn(() => service);
  const app = { keymap: new Keymap(), workspace: { containerEl: document.body } } as App;
  const access = new InkImportAccess({
    app,
    signal: owner.signal,
    createService,
    readMotion: () => "reduced",
    workScheduler: () => workSchedulerFromFrames(window),
  });
  return { access, createService, service, owner };
}

async function pendingHistoryFixture() {
  const context = fixture();
  const pending = deferred<readonly InkImportJournal[]>();
  context.service.history.mockReturnValueOnce(pending.promise);
  const reading = context.access.history(window, new AbortController().signal);
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(context.service.history).toHaveBeenCalledOnce());
  return { ...context, pending, rejected };
}

it("loads lazily and serializes journal reconciliation across history consumers", async () => {
  const { access, service, createService } = fixture();
  const pending = deferred<readonly InkImportJournal[]>();
  service.history.mockReturnValueOnce(pending.promise);
  expect(createService).not.toHaveBeenCalled();
  const first = access.history(window, new AbortController().signal);
  await vi.waitFor(() => expect(service.history).toHaveBeenCalledOnce());
  const second = access.history(window, new AbortController().signal);
  await Promise.resolve();
  expect(service.history).toHaveBeenCalledOnce();
  pending.resolve([journal()]);
  expect(await first).toEqual([journal()]);
  expect(await second).toEqual([journal()]);
  expect(service.history).toHaveBeenCalledTimes(2);
});

it("preserves caller cancellation and permits a retry after failed history reads", async () => {
  const { access, service } = fixture();
  service.history.mockRejectedValueOnce(new Error("History unavailable"));
  await expect(access.history(window, new AbortController().signal)).rejects.toThrow(
    "History unavailable",
  );
  const pending = deferred<readonly InkImportJournal[]>();
  service.history.mockReturnValueOnce(pending.promise);
  const caller = new AbortController();
  const reading = access.history(window, caller.signal);
  const rejected = expect(reading).rejects.toMatchObject({ name: "AbortError" });
  await vi.waitFor(() => expect(service.history).toHaveBeenCalledTimes(2));
  caller.abort();
  expect(service.history.mock.calls[1]?.[0]?.aborted).toBe(true);
  pending.resolve([journal()]);
  await rejected;
  expect(await access.history(window, new AbortController().signal)).toEqual([journal()]);
});

it("opens one dialog and blocks reconciliation until it closes, then notifies subscribers", async () => {
  const { access, createService, service } = fixture();
  const changed = vi.fn();
  const release = access.subscribe(changed);
  await access.open(window);
  await access.open(window);
  expect(createService).toHaveBeenCalledOnce();
  await expect(access.history(window, new AbortController().signal)).rejects.toThrow(
    "Close the import window",
  );
  expect(service.history).not.toHaveBeenCalled();
  dialogButton("Close").click();
  expect(changed).toHaveBeenCalledOnce();
  release();
  await access.open(window, journal());
  expect(dialogButton("Undo import")).toBeDefined();
  dialogButton("Close").click();
  expect(changed).toHaveBeenCalledOnce();
  expect(await access.history(window, new AbortController().signal)).toEqual([journal()]);
});

it("aborts history but waits for its actual completion before opening a dialog", async () => {
  const { access, service, pending, rejected } = await pendingHistoryFixture();
  const opening = access.open(window);
  expect(service.history.mock.calls[0]?.[0]?.aborted).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  pending.resolve([]);
  await rejected;
  await opening;
  expect(dialogButton("Scan vault")).toBeDefined();
});

it("does not open a delayed dialog or notify listeners after plugin disposal", async () => {
  const { access, owner, createService, pending, rejected } = await pendingHistoryFixture();
  const changed = vi.fn();
  access.subscribe(changed);
  const opening = access.open(window);
  owner.abort();
  pending.resolve([]);
  await rejected;
  await opening;
  await access.open(window);
  expect(createService).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
});

it("cancels a delayed dialog when its settings owner closes while the plugin stays active", async () => {
  const { access, owner, createService, pending, rejected } = await pendingHistoryFixture();
  const caller = new AbortController();
  const opening = access.open(window, journal(), caller.signal);
  caller.abort();
  pending.resolve([]);
  await rejected;
  await opening;
  expect(owner.signal.aborted).toBe(false);
  expect(createService).toHaveBeenCalledOnce();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(await access.history(window, new AbortController().signal)).toEqual([journal()]);
  await access.open(window, journal(), caller.signal);
  expect(createService).toHaveBeenCalledTimes(2);
});

it("keeps a closed dialog exclusive until its stopped operation has drained", async () => {
  const { access, service, createService } = fixture();
  const pending = deferred<InkImportPreview>();
  service.scan.mockReturnValueOnce(pending.promise);
  const changed = vi.fn();
  access.subscribe(changed);
  await access.open(window);
  dialogButton("Scan vault").click();
  const operationSignal = service.scan.mock.calls[0]?.[0];
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  expect(operationSignal?.aborted).toBe(true);
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(changed).not.toHaveBeenCalled();
  await access.open(window);
  expect(createService).toHaveBeenCalledOnce();
  await expect(access.history(window, new AbortController().signal)).rejects.toThrow(
    "Close the import window",
  );
  pending.resolve({ id: "scan", sources: [], notes: {}, warnings: [], truncated: false });
  await vi.waitFor(() => expect(changed).toHaveBeenCalledOnce());
  expect(await access.history(window, new AbortController().signal)).toEqual([journal()]);
});
