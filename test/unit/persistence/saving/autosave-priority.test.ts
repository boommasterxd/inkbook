import { describe, expect, it, vi } from "vitest";

import { InteractiveWorkPriority } from "../../../../src/editor/session/interactive-work-priority";
import { AutosaveExportIntegrity } from "../../../../src/persistence/saving/autosave/export-integrity";
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
      const serialized = serializeInkbookDocument(snapshot());
      if (!serialized.ok) throw new Error(serialized.error.code);
      const runtime = new DocumentWorkerRuntime({ sessionId: "priority-session", workerEpoch: 1 });
      const execute = vi.spyOn(runtime, "execute");
      const pause = pausedBackground();
      const verifier = new AutosavePersistedOutputVerifier({
        executor: () => runtime,
        isDisposed: () => false,
        sessionId: "priority-session",
        switchToFallback: () => false,
        waitForBackground: pause.waitForBackground,
        workerEpoch: () => 1,
      });
      const verifying = verifier.verify(serialized.value.svg, purpose);
      expect(execute).not.toHaveBeenCalled();
      pause.resume();
      await expect(verifying).resolves.toMatchObject({
        outputHash: serialized.value.hash,
        revision: 0,
        type: "confirmed",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      await expect(
        verifier.verifyExpected(serialized.value.svg, 1, serialized.value.hash),
      ).resolves.toBe(false);
    },
  );
});
