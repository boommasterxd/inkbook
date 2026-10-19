import type { FileManager, TFile } from "obsidian";
import { describe, expect, it, vi } from "vitest";
import { SharedFrameScheduler } from "../../../../src/domain/scheduling/shared-frame-scheduler";

import * as safeSvg from "../../../../src/persistence/documents/safe-svg-validator";
import { saveRecoveryCopy } from "../../../../src/obsidian/embeds/vault-document-recovery";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import { ManualHost } from "../../../fixtures/scheduling/manual-frame-host";
import {
  emptySnapshot,
  operation,
  persistenceHarness,
  rectangle,
  TestTFile,
} from "./vault-session-fixtures";

describe("vault recovery completion", () => {
  it("reports and preserves a verified copy when requested Markdown replacement fails", async () => {
    const files = new Map<string, { file: TFile; text: string }>();
    const reportSavedPath = vi.fn();
    const replaceMarkdownTarget = vi.fn(async () => false);
    const executor = new DocumentWorkerRuntime({ sessionId: "session-1", workerEpoch: 1 });
    const host = new ManualHost();
    host.budget = 2;
    const workScheduler = new SharedFrameScheduler(host);
    const budgetMs = vi.spyOn(workScheduler, "budgetMs");
    const scan = vi.spyOn(safeSvg, "validateSafeSvgSteps");
    const result = await saveRecoveryCopy({
      completion: { replaceMarkdownTarget, reportSavedPath },
      documentId: "drawings/ink.svg",
      executor,
      fileManager: { trashFile: vi.fn() } as unknown as FileManager,
      files: {
        createOwnedAndReadBack: async (path, content) => {
          const file = new TestTFile(path, content.length);
          files.set(path, { file, text: content });
          const isCurrent = () => files.get(path)?.file === file;
          return {
            file,
            isCurrent,
            readBack: {
              content,
              identity: { ctime: 1, mtime: 1, path, size: content.length },
              isCurrent,
              materialization: "host-full-read-not-bounded",
              stabilityEvidence: "object-identity-and-stat-unchanged",
            },
          };
        },
        pathExists: (path) => files.has(path),
      },
      operation: { ...operation(), operationId: 2 },
      snapshot: emptySnapshot(),
      workScheduler,
      stopped: () => false,
      workerEpoch: 1,
    });

    expect(result).toMatchObject({ savedPath: "drawings/ink-recovered-1.svg", status: "failed" });
    expect(reportSavedPath).toHaveBeenCalledWith("drawings/ink-recovered-1.svg");
    expect(replaceMarkdownTarget).toHaveBeenCalledWith(
      "drawings/ink-recovered-1.svg",
      expect.any(Function),
    );
    expect(files.has("drawings/ink-recovered-1.svg")).toBe(true);
    expect(budgetMs).toHaveBeenCalled();
    expect(scan).not.toHaveBeenCalled();
    scan.mockRestore();
    workScheduler.dispose();
  });

  it("trashes the verified copy when recovery becomes stale during Markdown replacement", async () => {
    const { createdCopies, factory, session } = persistenceHarness();
    await session.unlock(operation());
    factory.getDocumentModel("session-1")?.commitElement(rectangle());
    let continueReplacement!: () => void;
    const replacementGate = new Promise<void>((resolve) => {
      continueReplacement = resolve;
    });
    const replaceMarkdownTarget = vi.fn(async (_savedPath: string, isCurrent: () => boolean) => {
      await replacementGate;
      return isCurrent();
    });
    const recoveryOperation = {
      ...operation(),
      baseRevision: 8,
      operationId: 2,
    };
    const recovery = session.resolveRecovery("save-local-copy", recoveryOperation, {
      replaceMarkdownTarget,
    });

    await vi.waitFor(() => expect(replaceMarkdownTarget).toHaveBeenCalledOnce());
    session.cancelOperation(recoveryOperation);
    continueReplacement();

    await expect(recovery).resolves.toMatchObject({ status: "failed" });
    expect(createdCopies.has("drawings/ink-recovered-1.svg")).toBe(false);
  });
});
