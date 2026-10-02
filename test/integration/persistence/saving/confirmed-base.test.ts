import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../../../../src/persistence/serialization/sha256";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import { AutosaveDocumentFixture, serializeSnapshot } from "./fixtures";

afterEach(() => vi.restoreAllMocks());

describe("confirmed base ownership across exports", () => {
  it.each([false, true])(
    "reuses the confirmed base for unchanged notifications and successive saves: divergent static=%s",
    async (divergent) => {
      const documentSource = new AutosaveDocumentFixture();
      const original = serializeSnapshot();
      const svg = divergent ? original.svg.replace(' d="', ' d="M 1 1 ') : original.svg;
      if (divergent) expect(svg).not.toBe(original.svg);
      const initial = { svg, hash: sha256Hex(svg) };
      let content = initial.svg;
      const executor = new DocumentWorkerRuntime({ sessionId: "confirmed", workerEpoch: 1 });
      await executor.execute({
        type: "unlock",
        input: content,
        identity: {
          sessionId: "confirmed",
          workerEpoch: 1,
          operationId: 1,
          purpose: "unlock",
        },
      });
      const execute = vi.spyOn(executor, "execute");
      const process = vi.fn(async (_path: string, update: (value: string) => string) => {
        content = update(content);
        return content;
      });
      const coordinator = new AutosaveCoordinator({
        workScheduler: createTestWorkScheduler(),
        clock: { clearTimeout: () => undefined, setTimeout: () => 0 },
        confirmedBase: { type: "confirmed", revision: 0, outputHash: initial.hash },
        documentSource,
        executor,
        initialSnapshot: documentSource.snapshot(),
        path: "drawing.svg",
        sessionId: "confirmed",
        workerEpoch: 1,
        vault: {
          process,
          readWithMetadataGuard: async (path) => ({
            content,
            identity: { path, size: content.length, ctime: 1, mtime: 1 },
            materialization: "host-full-read-not-bounded",
            stabilityEvidence: "object-identity-and-stat-unchanged",
          }),
        },
      });
      await expect(coordinator.notifyExternalChange()).resolves.toBe("unchanged");
      for (const revision of [1, 2, 3, 4]) {
        documentSource.commit(revision, 100 + revision);
        coordinator.recordCommit({ modelRevision: revision });
        await expect(coordinator.notifyExternalChange()).resolves.toBe("unchanged");
        await expect(coordinator.flush("retry")).resolves.toBe("clean");
      }
      expect(process).toHaveBeenCalledTimes(4);
      expect(
        execute.mock.calls.filter(([request]) => request.type === "verify-output"),
      ).toHaveLength(9);
      coordinator.dispose();
    },
  );
});
