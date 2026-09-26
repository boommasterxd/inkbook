import { describe, expect, it, vi } from "vitest";

import { InteractiveWorkPriority } from "../../../../src/editor/session/interactive-work-priority";
import { AutosaveExportIntegrity } from "../../../../src/persistence/saving/autosave/export-integrity";
import { hashSvgContent } from "../../../../src/persistence/scheduling/trusted-svg-output";
import { verifyExactWorkerContent } from "../../../../src/persistence/saving/autosave/trusted-verification";
import { AutosavePersistedOutputVerifier } from "../../../../src/persistence/saving/autosave/persisted-output-verifier";
import {
  deriveDocumentIntegrityManifest,
  serializeInkbookDocument,
} from "../../../../src/persistence/serialization/public";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import { snapshot } from "../worker/runtime/fixtures";

function pausedBackground() {
  let resume: () => void = () => undefined;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  return { resume, waitForBackground: () => pending };
}

function createVerificationHarness(
  options: {
    readonly waitForBackground?: () => Promise<void>;
    readonly isDisposed?: () => boolean;
  } = {},
) {
  const result = serializeInkbookDocument(snapshot());
  if (!result.ok) throw new Error(result.error.code);
  const runtime = new DocumentWorkerRuntime({ sessionId: "priority-session", workerEpoch: 1 });
  const execute = vi.spyOn(runtime, "execute");
  const verifier = new AutosavePersistedOutputVerifier({
    executor: () => runtime,
    isDisposed: () => false,
    sessionId: "priority-session",
    switchToFallback: () => false,
    workerEpoch: () => 1,
    ...options,
  });
  return { serialized: result.value, runtime, execute, verifier };
}

describe("autosave inspection priority", () => {
  it("defers authoritative snapshot materialization until background work resumes", async () => {
    const document = snapshot();
    const source = vi.fn(() => document);
    const pause = pausedBackground();
    const integrity = new AutosaveExportIntegrity(pause.waitForBackground);
    const verifying = integrity.verify(source, deriveDocumentIntegrityManifest(document));
    expect(source).not.toHaveBeenCalled();
    pause.resume();
    await expect(verifying).resolves.toBe("match");
    expect(source).toHaveBeenCalledTimes(1);
  });

  it("does not materialize a snapshot cancelled while waiting", async () => {
    const source = vi.fn(snapshot);
    const pause = pausedBackground();
    const controller = new AbortController();
    const integrity = new AutosaveExportIntegrity(pause.waitForBackground);
    const verifying = integrity.verify(
      source,
      deriveDocumentIntegrityManifest(snapshot()),
      controller.signal,
    );
    controller.abort();
    pause.resume();
    await expect(verifying).resolves.toBe("cancelled");
    expect(source).not.toHaveBeenCalled();
  });

  it("preserves the full-export retry when history changes the revision while verification is paused", async () => {
    const priority = new InteractiveWorkPriority();
    const release = priority.begin();
    let document = snapshot();
    const manifest = deriveDocumentIntegrityManifest(document);
    const source = vi.fn(() => document);
    const integrity = new AutosaveExportIntegrity(() => priority.waitForBackground());
    const verifying = integrity.verify(
      source,
      manifest,
      undefined,
      () => document.revision === manifest.revision,
    );
    document = { ...document, revision: document.revision + 1 };
    release();
    await expect(verifying).resolves.toBe("cancelled");
    expect(source).not.toHaveBeenCalled();
    await expect(integrity.verify(source, manifest)).resolves.toBe("retry-full");
    await expect(integrity.verify(source, manifest)).resolves.toBe("fail");
    priority.dispose();
  });

  it.each(["preflight", "read-back", "verification"] as const)(
    "retains exact %s verification after pausing",
    async (purpose) => {
      const pause = pausedBackground();
      const { serialized, execute, verifier, runtime } = createVerificationHarness(pause);
      const verifying = verifier.verify(serialized.svg, purpose);
      expect(execute).not.toHaveBeenCalled();
      pause.resume();
      await expect(verifying).resolves.toMatchObject({
        outputHash: serialized.hash,
        revision: 0,
        type: "confirmed",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(verifier.verifyExpected(serialized.svg, 1, serialized.hash)).resolves.toBe(
        false,
      );
      runtime.terminate();
    },
  );
});

describe("confirmed preflight base", () => {
  it.each(["hash", "revision"] as const)(
    "retains full verification for a mismatched %s",
    async (field) => {
      const { serialized, runtime, execute, verifier } = createVerificationHarness();
      await expect(
        verifier.verify(serialized.svg, "preflight", {
          type: "confirmed",
          revision: field === "revision" ? 1 : 0,
          outputHash: field === "hash" ? "0".repeat(64) : serialized.hash,
        }),
      ).resolves.toMatchObject({
        type: "confirmed",
        revision: 0,
        outputHash: serialized.hash,
      });
      expect(execute).toHaveBeenCalledTimes(1);
      runtime.terminate();
    },
  );

  it("does not publish a matching confirmed base after disposal during a hash checkpoint", async () => {
    const pause = pausedBackground();
    let disposed = false;
    const { serialized, runtime, execute, verifier } = createVerificationHarness({
      ...pause,
      isDisposed: () => disposed,
    });
    const verifying = verifier.verify(serialized.svg, "preflight", {
      type: "confirmed",
      revision: 0,
      outputHash: serialized.hash,
    });
    disposed = true;
    pause.resume();
    await expect(verifying).rejects.toThrow("disposed");
    expect(execute).not.toHaveBeenCalled();
    runtime.terminate();
  });
});

it("retains a confirmed base across multiple discarded canonical exports", async () => {
  const { serialized, runtime, execute, verifier } = createVerificationHarness();
  for (const revision of [1, 2, 3]) {
    const result = await runtime.execute({
      type: "export-full",
      snapshot: { ...snapshot(), revision },
      baseModelRevision: null,
      modelRevision: revision,
      exportGeneration: revision,
      sessionId: "priority-session",
      workerEpoch: 1,
    });
    if (result.type !== "export-success") throw new Error("Export failed");
    runtime.acknowledgeExport(result, false);
  }
  execute.mockClear();
  await expect(
    verifier.verify(serialized.svg, "preflight", {
      type: "confirmed",
      revision: 0,
      outputHash: serialized.hash,
    }),
  ).resolves.toMatchObject({ type: "confirmed", revision: 0 });
  expect(execute).not.toHaveBeenCalled();
  runtime.terminate();
});

it.each(["read-back", "verification"] as const)(
  "does not reuse a noncanonical source proof for %s",
  async (purpose) => {
    const { serialized, runtime, execute } = createVerificationHarness();
    const content = serialized.svg.replace(' d="', ' d="M 1 1 ');
    expect(content).not.toBe(serialized.svg);
    await expect(
      verifyExactWorkerContent(
        runtime,
        {
          operationId: 1,
          purpose,
          sessionId: "priority-session",
          workerEpoch: 1,
        },
        content,
        "editable",
        {
          confirmedBase: {
            type: "confirmed",
            revision: 0,
            outputHash: await hashSvgContent(content),
          },
        },
      ),
    ).resolves.toEqual({ type: "unreadable" });
    expect(execute).toHaveBeenCalledTimes(1);
    runtime.terminate();
  },
);
