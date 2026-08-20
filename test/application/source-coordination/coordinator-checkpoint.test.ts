import { describe, expect, it } from "vitest";

import {
  createSidecarRevision,
  parseSha256Digest,
} from "../../../src/application/note-session";
import {
  createCoordinatorFixture,
  insertionTransition,
} from "./coordinator-test-support";
import { flushSourceMicrotasks } from "./support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact checkpoint generations define durable source ordering. */

describe("source checkpoint bases and forced barriers", () => {
  it("reads and validates the current sidecar base for every checkpoint", async () => {
    const fixture = await createCoordinatorFixture();
    await fixture.coordinator.admit(
      insertionTransition("pane-a", 1, "abc", "aXbc"),
    );
    fixture.scheduler.advance(100);
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await flushSourceMicrotasks();

    const replacementBase = Object.freeze({
      markdownPath: "notes/source.md",
      rawTextSha256: parseSha256Digest("b".repeat(64)),
      revision: createSidecarRevision(2),
      vaultRelativePath: "notes/source.inkbook.json",
    });
    fixture.setBase(replacementBase);
    await fixture.coordinator.admit(
      insertionTransition("pane-a", 2, "aXbc", "aXYbc"),
    );
    fixture.scheduler.advance(100);

    expect(fixture.recovery.checkpoints.map(({ base }) => base)).toEqual([
      expect.objectContaining({ revision: 1 }),
      replacementBase,
    ]);
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await flushSourceMicrotasks();
    expect(fixture.saves).toEqual([2, 3]);
  });

  it("retains checkpoint work and blocks saves for an invalid rebased base", async () => {
    const fixture = await createCoordinatorFixture();
    fixture.setBase({
      markdownPath: "notes/source.md",
      rawTextSha256: parseSha256Digest("b".repeat(64)),
      revision: null,
      vaultRelativePath: "notes/source.inkbook.json",
    });
    const admission = await fixture.coordinator.admit(
      insertionTransition("pane-a", 1, "abc", "aXbc"),
    );
    expect(admission.ok).toBe(true);
    const barrier = fixture.coordinator.beginForcedBarrier();
    await expect(barrier.completion).resolves.toEqual({
      ok: false,
      code: "sidecar-conflict",
    });
    expect(fixture.coordinator.sourceState).toMatchObject({
      failure: "sidecar-conflict",
      kind: "checkpoint-pending",
    });
    expect(fixture.recovery.checkpoints).toHaveLength(0);
    expect(fixture.saves).toHaveLength(0);
    fixture.setBase({
      markdownPath: "notes/source.md",
      rawTextSha256: parseSha256Digest("c".repeat(64)),
      revision: createSidecarRevision(2),
      vaultRelativePath: "notes/source.inkbook.json",
    });
    expect(fixture.coordinator.retryCheckpoint()).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.recovery.checkpoints).toHaveLength(1);
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await flushSourceMicrotasks();
    expect(fixture.saves).toEqual([2]);
  });

  it("returns a split-phase forced barrier before recovery acknowledgement", async () => {
    const fixture = await createCoordinatorFixture();
    await fixture.coordinator.admit(
      insertionTransition("pane-a", 1, "abc", "aXbc"),
    );
    const barrier = fixture.coordinator.beginForcedBarrier();
    let settled = false;
    void barrier.completion.then(() => {
      settled = true;
    });
    await flushSourceMicrotasks();
    expect(settled).toBe(false);
    expect(fixture.recovery.checkpoints).toHaveLength(1);
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await expect(barrier.completion).resolves.toMatchObject({ ok: true });
  });
});
