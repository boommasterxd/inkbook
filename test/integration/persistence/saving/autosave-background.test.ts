import { describe, expect, it } from "vitest";

import { parseInkbookDocument } from "../../../../src/persistence/serialization/public";
import { AutosaveCoordinator } from "../../../../src/persistence/saving/autosave/public";
import type { MetadataGuardedFileRead } from "../../../../src/persistence/saving/save-ports";
import { DocumentWorkerRuntime } from "../../../../src/persistence/worker/runtime/public";
import { snapshot } from "../../../unit/persistence/worker/runtime/fixtures";
import { AutosaveDocumentFixture, serializeSnapshot } from "./fixtures";

describe("autosave page backgrounds", () => {
  it("persists a dots-to-squares page-only change with square guide geometry", async () => {
    const harness = await createBackgroundHarness();
    const dots = {
      ...harness.source.value.page,
      background: { spacing: 25 as const, type: "dots" as const },
    };
    harness.source.commitPage(1, dots);
    harness.coordinator.recordCommit({ modelRevision: 1, page: dots });
    await expect(harness.coordinator.flush("retry")).resolves.toBe("clean");

    const squares = {
      ...dots,
      background: { spacing: 25 as const, type: "squares" as const },
    };
    harness.source.commitPage(2, squares);
    harness.coordinator.recordCommit({ modelRevision: 2, page: squares });
    await expect(harness.coordinator.flush("retry")).resolves.toBe("clean");

    expect(parseInkbookDocument(harness.vault.content)).toMatchObject({
      ok: true,
      value: { snapshot: { page: squares, revision: 2 } },
    });
    expect(harness.vault.content).toContain('stroke-linecap="butt"');
    expect(harness.vault.content).toMatch(/M24\.3 49\.3L2024\.3 49\.3/u);
    expect(harness.vault.content).toMatch(/M24\.3 24\.3L24\.3 [0-9.]+/u);
  });
});

async function createBackgroundHarness() {
  const initialSnapshot = snapshot();
  const initial = serializeSnapshot(initialSnapshot);
  const executor = new DocumentWorkerRuntime({ sessionId: "background-session", workerEpoch: 1 });
  await executor.execute({
    identity: {
      operationId: 1,
      purpose: "unlock",
      sessionId: "background-session",
      workerEpoch: 1,
    },
    input: initial.svg,
    type: "unlock",
  });
  const source = new AutosaveDocumentFixture();
  const vault = new BackgroundMemoryVault(initial.svg);
  const coordinator = new AutosaveCoordinator({
    clock: { clearTimeout: () => undefined, setTimeout: () => 1 },
    confirmedBase: { outputHash: initial.hash, revision: 0, type: "confirmed" },
    confirmedContent: initial.svg,
    documentSource: source,
    executor,
    initialSnapshot,
    path: "background.svg",
    sessionId: "background-session",
    vault,
    workerEpoch: 1,
  });
  return { coordinator, source, vault };
}

class BackgroundMemoryVault {
  public constructor(public content: string) {}

  public async process(_path: string, update: (current: string) => string): Promise<string> {
    this.content = update(this.content);
    return this.content;
  }

  public async read(): Promise<string> {
    return this.content;
  }

  public async readWithMetadataGuard(
    path: string,
    _maximumBytes: number,
  ): Promise<MetadataGuardedFileRead> {
    return {
      content: this.content,
      identity: { ctime: 1, mtime: 1, path, size: await this.size() },
      materialization: "host-full-read-not-bounded",
      stabilityEvidence: "object-identity-and-stat-unchanged",
    };
  }

  public async size(): Promise<number> {
    return new TextEncoder().encode(this.content).byteLength;
  }
}
