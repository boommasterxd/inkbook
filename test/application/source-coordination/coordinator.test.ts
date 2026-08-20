import { describe, expect, it } from "vitest";

import {
  createSourceGeneration,
  parseSha256Digest,
} from "../../../src/application/note-session";
import {
  createCoordinatorFixture as createFixture,
  insertionTransition as insertion,
} from "./coordinator-test-support";
import {
  ControlledSourceMapWorkPort,
  ImmediateSourceMapWorkPort,
  digestUtf8,
  flushSourceMicrotasks,
  flushSourceUntil,
} from "./support";

/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact sequences and generations define coordinator ordering. */

describe("Markdown source coordinator admission", () => {
  it.each([
    ["pane-a", "pane-b"],
    ["pane-b", "pane-a"],
  ] as const)(
    "admits one cross-pane transition in %s then %s order",
    async (firstPane, secondPane) => {
      const fixture = await createFixture();
      const first = await fixture.coordinator.admit(
        insertion(firstPane, 1, "abc", "aXbc"),
      );
      const duplicate = await fixture.coordinator.admit(
        insertion(secondPane, 1, "abc", "aXbc"),
      );
      expect(first.ok && first.value.kind).toBe("admitted");
      expect(duplicate.ok && duplicate.value.kind).toBe("duplicate");
      expect(fixture.coordinator.currentSource.generation).toBe(2);
      if (!first.ok || first.value.kind !== "admitted") return;
      expect(fixture.coordinator.currentSource.snapshot).toBe(
        first.value.snapshot,
      );

      fixture.scheduler.advance(100);
      expect(fixture.recovery.checkpoints).toHaveLength(1);
      fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
      await flushSourceMicrotasks();
      expect(fixture.saves).toEqual([2]);
      expect(fixture.durableSnapshots[0]).toBe(first.value.snapshot);
    },
  );

  it("fails a digest or canonical-map mismatch closed", async () => {
    const fixture = await createFixture();
    const mismatch = await fixture.coordinator.admit({
      ...insertion("pane-a", 1, "abc", "aXbc"),
      offsetMapDigest: parseSha256Digest("f".repeat(64)),
    });
    expect(mismatch).toEqual({ ok: false, code: "stale-source" });
    expect(fixture.coordinator.mismatchDigest).toBe(digestUtf8("aXbc"));
    expect(fixture.coordinator.currentSource.generation).toBe(1);
    expect(fixture.recovery.checkpoints).toHaveLength(0);
  });

  it("requires exact source generation and digest CAS identity", async () => {
    const fixture = await createFixture();
    const mismatch = await fixture.coordinator.admit({
      ...insertion("pane-a", 1, "abc", "aXbc"),
      priorGeneration: createSourceGeneration(2),
    });

    expect(mismatch).toEqual({ ok: false, code: "stale-source" });
    expect(fixture.coordinator.mismatchDigest).toBe(digestUtf8("aXbc"));
    expect(fixture.coordinator.currentSource.generation).toBe(1);
  });

  it("rejects equal-sequence divergent replay", async () => {
    const fixture = await createFixture();
    expect(
      (await fixture.coordinator.admit(insertion("pane-a", 1, "abc", "aXbc")))
        .ok,
    ).toBe(true);
    expect(
      await fixture.coordinator.admit(insertion("pane-a", 1, "aXbc", "aXYbc")),
    ).toEqual({ ok: false, code: "stale-source" });
  });
});

describe("source checkpoint scheduling and barriers", () => {
  it("keeps one active and one replaceable latest checkpoint", async () => {
    const fixture = await createFixture();
    await fixture.coordinator.admit(insertion("pane-a", 1, "abc", "aXbc"));
    fixture.scheduler.advance(100);
    expect(fixture.recovery.checkpoints).toHaveLength(1);

    await fixture.coordinator.admit(insertion("pane-a", 2, "aXbc", "aXYbc"));
    await fixture.coordinator.admit(insertion("pane-a", 3, "aXYbc", "aXYZbc"));
    expect(fixture.recovery.checkpoints).toHaveLength(1);
    const barrier = fixture.coordinator.beginForcedBarrier();

    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await flushSourceMicrotasks();
    expect(fixture.recovery.checkpoints).toHaveLength(2);
    expect(fixture.recovery.checkpoints[1]).toMatchObject({
      priorGeneration: 2,
      replacementGeneration: 4,
    });
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await expect(barrier.completion).resolves.toMatchObject({ ok: true });
    expect(fixture.saves).toEqual([2, 4]);
  });

  it("retries a failed checkpoint without duplicating publication", async () => {
    const fixture = await createFixture();
    await fixture.coordinator.admit(insertion("pane-a", 1, "abc", "aXbc"));
    fixture.scheduler.advance(100);
    fixture.recovery.acknowledgeNext({
      ok: false,
      code: "recovery-unavailable",
    });
    await flushSourceMicrotasks();
    expect(fixture.saves).toHaveLength(0);

    expect(fixture.coordinator.retryCheckpoint()).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.recovery.checkpoints).toHaveLength(2);
    expect(fixture.recovery.checkpoints[1]).toBe(
      fixture.recovery.checkpoints[0],
    );
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await flushSourceMicrotasks();
    expect(fixture.saves).toEqual([2]);
  });

  it("retries a rejected checkpoint append fail closed", async () => {
    const fixture = await createFixture();
    await fixture.coordinator.admit(insertion("pane-a", 1, "abc", "aXbc"));
    fixture.scheduler.advance(100);
    fixture.recovery.rejectNext(new Error("Injected persistence rejection."));
    await flushSourceMicrotasks();

    expect(fixture.coordinator.retryCheckpoint()).toEqual({
      ok: true,
      value: undefined,
    });
    expect(fixture.recovery.checkpoints).toHaveLength(2);
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await flushSourceMicrotasks();
    expect(fixture.saves).toEqual([2]);
  });
});

describe("source checkpoint failure containment", () => {
  it("blocks save publication when a later source transition fails", async () => {
    const fixture = await createFixture();
    await fixture.coordinator.admit(insertion("pane-a", 1, "abc", "aXbc"));
    fixture.scheduler.advance(100);
    expect(fixture.recovery.checkpoints).toHaveLength(1);
    const mismatch = await fixture.coordinator.admit({
      ...insertion("pane-a", 2, "aXbc", "aXYbc"),
      offsetMapDigest: parseSha256Digest("f".repeat(64)),
    });
    expect(mismatch).toEqual({ ok: false, code: "stale-source" });
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await flushSourceMicrotasks();
    expect(fixture.saves).toHaveLength(0);
    expect(fixture.durableSnapshots).toHaveLength(0);
    expect(fixture.coordinator.sourceState).toMatchObject({
      failure: "stale-source",
      kind: "reattaching",
    });
  });

  it("rejects a completion after disposal", async () => {
    const fixture = await createFixture();
    await fixture.coordinator.admit(insertion("pane-a", 1, "abc", "aXbc"));
    fixture.scheduler.advance(100);
    const barrier = fixture.coordinator.beginForcedBarrier();
    fixture.coordinator.dispose();
    fixture.recovery.acknowledgeNext({ ok: true, value: undefined });
    await expect(barrier.completion).resolves.toEqual({
      ok: false,
      code: "disposed",
    });
    expect(fixture.saves).toHaveLength(0);
  });
});

describe("source map worker coordination", () => {
  it("compacts proactively before the 33rd graph hop", async () => {
    const mapWork = new ImmediateSourceMapWorkPort();
    const fixture = await createFixture({ map: mapWork });
    let markdown = "abc";
    for (let sequence = 1; sequence <= 32; sequence += 1) {
      const replacement = `${markdown}x`;
      const result = await fixture.coordinator.admit(
        insertion("pane-a", sequence, markdown, replacement),
      );
      expect(result.ok).toBe(true);
      markdown = replacement;
    }
    expect(fixture.coordinator.currentSource.depth).toBe(32);
    expect(mapWork.requests.some(({ segments }) => segments.length > 2)).toBe(
      false,
    );

    const admitted = await fixture.coordinator.admit(
      insertion("pane-a", 33, markdown, `${markdown}x`),
    );
    expect(admitted.ok).toBe(true);
    if (!admitted.ok || admitted.value.kind !== "admitted") return;
    expect(fixture.coordinator.currentSource.snapshot).toBe(
      admitted.value.snapshot,
    );
    expect(
      mapWork.requests.some(({ segments }) => segments.length === 32),
    ).toBe(true);
    expect(fixture.coordinator.currentSource.depth).toBe(2);
    expect(fixture.coordinator.retainedSourceBytes).toBeLessThanOrEqual(
      48 * 1024 * 1024,
    );
  });

  it("rejects a stale completion after a newer admission publishes", async () => {
    const mapWork = new ControlledSourceMapWorkPort();
    const fixture = await createFixture({ map: mapWork });
    await fixture.coordinator.admit(insertion("pane-a", 1, "abc", "aXbc"));
    const stale = fixture.coordinator.admit(
      insertion("pane-a", 2, "aXbc", "aXYbc"),
    );
    await flushSourceUntil(() => mapWork.pending.length === 1);
    const current = fixture.coordinator.admit(
      insertion("pane-b", 2, "aXbc", "aXZbc"),
    );
    await flushSourceUntil(() => mapWork.pending.length === 2);
    expect(mapWork.pending).toHaveLength(2);
    mapWork.complete(1);
    expect((await current).ok).toBe(true);
    mapWork.complete(0);
    await expect(stale).resolves.toEqual({ ok: false, code: "stale-source" });
    expect(fixture.coordinator.currentSource.digest).toBe(digestUtf8("aXZbc"));
  });

  it("cancels active work on disposal and contains worker crashes", async () => {
    const cancelledWork = new ControlledSourceMapWorkPort();
    const cancelledFixture = await createFixture({ map: cancelledWork });
    await cancelledFixture.coordinator.admit(
      insertion("pane-a", 1, "abc", "aXbc"),
    );
    const pending = cancelledFixture.coordinator.admit(
      insertion("pane-a", 2, "aXbc", "aXYbc"),
    );
    await flushSourceUntil(() => cancelledWork.pending.length === 1);
    cancelledFixture.coordinator.dispose();
    expect(cancelledWork.pending[0]?.cancelled).toBe(true);
    cancelledWork.complete(0);
    await expect(pending).resolves.toEqual({ ok: false, code: "disposed" });

    const crashedWork = new ControlledSourceMapWorkPort();
    const crashedFixture = await createFixture({ map: crashedWork });
    await crashedFixture.coordinator.admit(
      insertion("pane-a", 1, "abc", "aXbc"),
    );
    const crashed = crashedFixture.coordinator.admit(
      insertion("pane-a", 2, "aXbc", "aXYbc"),
    );
    await flushSourceUntil(() => crashedWork.pending.length === 1);
    crashedWork.pending[0]?.reject(new Error("Injected worker crash."));
    await expect(crashed).resolves.toEqual({
      ok: false,
      code: "recovery-unavailable",
    });
    expect(crashedFixture.coordinator.sourceState).toMatchObject({
      failure: "recovery-unavailable",
      kind: "reattaching",
    });
  });
});
