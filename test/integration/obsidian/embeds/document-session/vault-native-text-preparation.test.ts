// @vitest-environment happy-dom
import { afterEach, expect, it, vi } from "vitest";
import { prepareNativeTextInkBounds } from "../../../../../src/obsidian/text/native-text-ink-bounds";
import { loadBuiltinFont } from "../../../../../src/persistence/fonts/builtin-fonts";
import { DocumentWorkerRuntime } from "../../../../../src/persistence/worker/runtime/public";
import { TrustedDocumentHeadLedger } from "../../../../../src/obsidian/storage/trusted-document-head-ledger";
import type { VaultDocumentSessionHooks } from "../../../../../src/obsidian/embeds/document-session/vault-document-recovery";
import { createTestWorkScheduler } from "../../../../fixtures/persistence/work-scheduler";
import {
  installNativeTextInkHost,
  nativeInkText,
} from "../../../../fixtures/obsidian/native-text-ink";
import { legacyImageDocument } from "../../../../fixtures/persistence/legacy-image-svg";
import { parseInkbookDocumentForTest } from "../../../../fixtures/persistence/parse-document";
import {
  documentFromSnapshot,
  emptySnapshot,
  operation,
  persistenceHarness,
} from "./vault-session-fixtures";

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

async function fixture(
  version: 2 | 3 | 4,
  hooks: Pick<VaultDocumentSessionHooks, "trustedHeads"> = {},
) {
  const scheduler = createTestWorkScheduler();
  const font = await loadBuiltinFont("inter", 400, "normal", scheduler);
  const element = { ...nativeInkText(font), ...(version === 4 ? { locked: true } : {}) };
  const source =
    version === 2
      ? documentFromSnapshot({
          ...emptySnapshot(),
          version,
          elements: [element],
          fontResources: [font],
        })
      : legacyImageDocument(version, { element, font });
  const host = installNativeTextInkHost();
  const prepare = vi.fn<NonNullable<VaultDocumentSessionHooks["prepareTextInkBounds"]>>(
    (documentId, snapshot, cancelled, elements) => {
      expect(documentId).toBe("drawings/ink.svg");
      return prepareNativeTextInkBounds({
        document,
        elements,
        resources: snapshot.fontResources ?? [],
        cancelled,
        scheduler,
      });
    },
  );
  const harness = persistenceHarness(emptySnapshot(), { prepareTextInkBounds: prepare, ...hooks });
  harness.replaceExternal(source);
  return { source, element, host, harness, prepare };
}

it.each([2, 3, 4] as const)(
  "prepares native glyph metadata for version %s before adoption, backup and canonical save",
  async (version) => {
    const f = await fixture(version);
    const execute = vi.spyOn(DocumentWorkerRuntime.prototype, "execute");
    try {
      expect((await f.harness.session.unlock(operation())).status).toBe("active");
      const model = f.harness.session.documentModel!;
      const element = model.store.get(f.element.id)!.element;
      expect(element).toMatchObject({
        x: f.element.x,
        y: f.element.y,
        width: f.element.width,
        height: f.element.height,
      });
      expect(element.locked).toBe(f.element.locked);
      expect(element.kind === "text" && element.layout.lines[0]!.runs[0]!.inkBounds).toEqual({
        minX: -1.6,
        minY: -20,
        maxX: 48,
        maxY: 4,
      });
      expect(model.revision).toBe(7);
      expect(model.formatVersion).toBe(5);
      const sync = execute.mock.calls
        .map(([request]) => request)
        .filter((request) => request.type === "model-sync-incremental");
      expect(sync).toHaveLength(1);
      expect(sync[0]).toMatchObject({
        baseModelRevision: 7,
        modelRevision: 7,
        changedElements: [element],
      });
      expect(sync[0]).not.toHaveProperty("snapshot");
      expect(f.host.retained.size).toBe(0);
      expect((await f.harness.session.lockLatest(operation())).status).toBe("confirmed");
      expect(f.harness.createdCopies.get(`drawings/ink.backup-v${version}.svg`)?.text).toBe(
        f.source.svg,
      );
      const saved = await parseInkbookDocumentForTest(f.harness.content());
      expect(saved.ok).toBe(true);
      if (saved.ok) {
        expect(saved.value.snapshot.version).toBe(5);
        expect(saved.value.snapshot.elements.find(({ id }) => id === f.element.id)).toEqual(
          element,
        );
      }
    } finally {
      f.harness.session.dispose();
      f.host.dispose();
    }
  },
);

it("rejects a trusted-head conflict before native fonts or text preparation run", async () => {
  let stored: unknown;
  const trustedHeads = new TrustedDocumentHeadLedger({
    loadLocalStorage: () => structuredClone(stored),
    saveLocalStorage: (_key, value) => {
      stored = structuredClone(value);
    },
  });
  expect(
    trustedHeads.reconcile({
      documentId: "drawings/ink.svg",
      revision: 8,
      outputHash: "a".repeat(64),
    }),
  ).toMatchObject({ status: "created" });
  const f = await fixture(2, { trustedHeads });
  try {
    expect((await f.harness.session.unlock(operation())).status).toBe("source-changed");
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.host.created).toHaveLength(0);
    expect(f.harness.process).not.toHaveBeenCalled();
  } finally {
    f.harness.session.dispose();
    f.host.dispose();
  }
});

it("keeps cancelled native preparation unpublished and leaves the original file unchanged", async () => {
  const f = await fixture(2);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const original = f.prepare.getMockImplementation()!;
  f.prepare.mockImplementationOnce(async (...args) => {
    await gate;
    return original(...args);
  });
  try {
    const pending = f.harness.session.unlock(operation());
    await vi.waitFor(() => expect(f.prepare).toHaveBeenCalledOnce());
    f.harness.session.cancelOperation(operation());
    release();
    expect((await pending).status).toBe("load-error");
    assertUnpublishedPreparation(f);
  } finally {
    f.harness.session.dispose();
    f.host.dispose();
  }
});

it("does not initialize native text preparation or sync when there is no text", async () => {
  const prepareTextInkBounds = vi.fn(async () => []);
  const execute = vi.spyOn(DocumentWorkerRuntime.prototype, "execute");
  const harness = persistenceHarness(emptySnapshot(), { prepareTextInkBounds });
  try {
    expect((await harness.session.unlock(operation())).status).toBe("active");
    expect(prepareTextInkBounds).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([request]) => request.type === "model-sync-incremental")).toBe(
      false,
    );
    expect(harness.process).not.toHaveBeenCalled();
  } finally {
    harness.session.dispose();
  }
});

it("leaves native preparation failures recoverable without a partial save or backup", async () => {
  const f = await fixture(2);
  const execute = vi.spyOn(DocumentWorkerRuntime.prototype, "execute");
  f.prepare.mockRejectedValue(new Error("Native font measurement failed."));
  try {
    expect((await f.harness.session.unlock(operation())).status).toBe("load-error");
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(execute.mock.calls.filter(([request]) => request.type === "unlock")).toHaveLength(1);
    assertUnpublishedPreparation(f);
  } finally {
    f.harness.session.dispose();
    f.host.dispose();
  }
});

it("does not adopt host-derived text when the worker cannot synchronize the derived metadata", async () => {
  const f = await fixture(2);
  const prepare = f.prepare.getMockImplementation()!;
  f.prepare.mockImplementationOnce(async (...args) => {
    const changed = await prepare(...args);
    vi.spyOn(DocumentWorkerRuntime.prototype, "execute").mockImplementation(async (request) => {
      if (!("identity" in request)) throw new Error("Worker is unavailable.");
      return {
        type: "runtime-failure",
        identity: request.identity,
        code: "snapshot-invalid",
        retryable: false,
      };
    });
    return changed;
  });
  try {
    expect((await f.harness.session.unlock(operation())).status).toBe("load-error");
    assertUnpublishedPreparation(f);
  } finally {
    f.harness.session.dispose();
    f.host.dispose();
  }
});

function assertUnpublishedPreparation(f: Awaited<ReturnType<typeof fixture>>): void {
  expect(f.harness.session.documentModel).toBeUndefined();
  expect(f.harness.process).not.toHaveBeenCalled();
  expect(f.harness.createdCopies.size).toBe(0);
  expect(f.harness.content()).toBe(f.source.svg);
  expect(f.host.retained.size).toBe(0);
}
