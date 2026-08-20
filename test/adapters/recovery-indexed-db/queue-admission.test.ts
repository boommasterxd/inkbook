/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact queue boundaries are the behavior under test. */
import { describe, expect, it } from "vitest";

import { encodeRecoveryRecordV1 } from "../../../src/application/recovery";
import { admitQueueRequest } from "../../../src/adapters/recovery-indexed-db/queue-admission";
import {
  createSidecarRevision,
  parseSha256Digest,
} from "../../../src/application/note-session";
import {
  BASE,
  DIGEST_A,
  existingLoad,
  fileRelocation,
  hostAcknowledgement,
  openStore,
  prefixRelocation,
  preparedAttempt,
} from "./support";

describe("IndexedDB recovery queue admission", () => {
  it("bounds outstanding store operations at and above local queue capacity", async () => {
    const { store } = await openStore("bounded-operation-queue", {
      limits: { queuedOperations: 2 },
    });
    const below = store.prepareForward(preparedAttempt(1, 1));
    const at = store.prepareForward(preparedAttempt(2, 2, queueBase(2)));
    const above = store.prepareForward(preparedAttempt(3, 3, queueBase(3)));

    await expect(below).resolves.toEqual({ ok: true, value: undefined });
    await expect(at).resolves.toEqual({ ok: true, value: undefined });
    await expect(above).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await expect(
      store.prepareForward(preparedAttempt(3, 3, queueBase(3))),
    ).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();
  });

  it("bounds exact queued record bytes below, at, and above capacity", async () => {
    const firstAttempt = preparedAttempt(1, 1);
    const secondAttempt = preparedAttempt(2, 2, queueBase(2));
    const thirdAttempt = preparedAttempt(3, 3, queueBase(3));
    const firstBytes = encodeRecoveryRecordV1(firstAttempt);
    const secondBytes = encodeRecoveryRecordV1(secondAttempt);
    if (!firstBytes.ok || !secondBytes.ok) {
      throw new Error("Expected queue fixture encoding.");
    }
    const { store } = await openStore("bounded-operation-bytes", {
      limits: {
        queuedBytes: firstBytes.value.byteLength + secondBytes.value.byteLength,
        queuedOperations: 3,
      },
    });
    const below = store.prepareForward(firstAttempt);
    const at = store.prepareForward(secondAttempt);
    const above = store.prepareForward(thirdAttempt);

    await expect(below).resolves.toEqual({ ok: true, value: undefined });
    await expect(at).resolves.toEqual({ ok: true, value: undefined });
    await expect(above).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });
    await expect(store.prepareForward(thirdAttempt)).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await store.dispose();
  });

  it("reserves completion capacity for an accepted recovery acknowledgement", async () => {
    const { store } = await openStore("reserved-completion-queue", {
      limits: { queuedOperations: 8 },
    });
    const attempts = Array.from({ length: 4 }, (_, index) =>
      preparedAttempt(index + 1, index + 1),
    );
    const writes = attempts.map((attempt) => store.prepareForward(attempt));
    await expect(store.prepareForward(preparedAttempt(5, 5))).resolves.toEqual({
      ok: false,
      code: "recovery-limit",
    });

    const firstAttempt = attempts[0];
    if (firstAttempt === undefined) throw new Error("Expected an attempt.");
    const acknowledgement = store.recordForward(
      firstAttempt.attemptId,
      hostAcknowledgement(),
    );

    await expect(Promise.all(writes)).resolves.toEqual(
      attempts.map(() => ({ ok: true, value: undefined })),
    );
    await expect(acknowledgement).resolves.toMatchObject({
      ok: true,
      value: {
        attemptId: firstAttempt.attemptId,
        kind: "host-recorded-forward",
      },
    });
    await store.dispose();
  });
});

describe("IndexedDB recovery hostile queue admission", () => {
  it("materializes proxy records without getters and isolates later mutation", async () => {
    const { store } = await openStore("proxy-record-materialization");
    const target = { ...preparedAttempt() };
    let getterReads = 0;
    const proxy = new Proxy(target, {
      get: (): never => {
        getterReads += 1;
        throw new Error("Proxy getters must not run during admission.");
      },
    });

    const write = store.prepareForward(proxy);
    Reflect.set(target, "sessionOrder", 99);

    await expect(write).resolves.toEqual({ ok: true, value: undefined });
    expect(getterReads).toBe(0);
    await expect(store.loadNote(existingLoad())).resolves.toMatchObject({
      ok: true,
      value: { attempts: [{ sessionOrder: 1 }] },
    });
    await store.dispose();
  });

  it("reads proxy arrays and transition wrappers only through descriptors", async () => {
    const { store } = await openStore("proxy-descriptor-admission");
    let getterReads = 0;
    const get = (): never => {
      getterReads += 1;
      throw new Error("Proxy getters must not run during admission.");
    };
    const request = {
      ...existingLoad(),
      hostileValues: new Proxy([null], { get }),
    };
    await expect(
      store.loadNote(
        request as unknown as Parameters<typeof store.loadNote>[0],
      ),
    ).resolves.toMatchObject({ ok: true });

    const expected = fileRelocation();
    const replacement = fileRelocation("sidecar-moved");
    await store.beginRelocation(expected);
    await expect(
      store.advanceRelocation(new Proxy({ expected, replacement }, { get })),
    ).resolves.toEqual({ ok: true, value: undefined });
    expect(getterReads).toBe(0);
    await store.dispose();
  });
});

describe("IndexedDB recovery rejected queue inputs", () => {
  it("bounds cumulative string and property-key units below, at, and above", () => {
    const unitBudget = 256 * 1024;
    const keyUnits = "left".length + "right".length;
    const request = (units: number): Readonly<Record<string, string>> => {
      const valueUnits = units - keyUnits;
      const leftUnits = Math.floor(valueUnits / 2);
      return {
        left: "a".repeat(leftUnits),
        right: "b".repeat(valueUnits - leftUnits),
      };
    };

    expect(admitQueueRequest(request(unitBudget - 1)).ok).toBe(true);
    expect(admitQueueRequest(request(unitBudget)).ok).toBe(true);
    expect(admitQueueRequest(request(unitBudget + 1))).toEqual({
      ok: false,
      code: "recovery-limit",
    });
  });

  it("rejects long keys, many aggregate strings, and oversized own-key sets early", () => {
    const unitBudget = 256 * 1024;
    expect(admitQueueRequest({ ["k".repeat(unitBudget + 1)]: null })).toEqual({
      ok: false,
      code: "recovery-limit",
    });
    expect(admitQueueRequest(new Array(257).fill("v".repeat(1024)))).toEqual({
      ok: false,
      code: "recovery-limit",
    });

    let descriptorReads = 0;
    const properties = Object.fromEntries(
      Array.from({ length: 16_384 }, (_, index) => [`k${String(index)}`, null]),
    );
    const oversized = new Proxy(properties, {
      getOwnPropertyDescriptor: (
        target,
        key,
      ): PropertyDescriptor | undefined => {
        descriptorReads += 1;
        return Object.getOwnPropertyDescriptor(target, key);
      },
    });
    expect(admitQueueRequest(oversized)).toEqual({
      ok: false,
      code: "recovery-limit",
    });
    expect(descriptorReads).toBe(0);
  });
});

describe("IndexedDB recovery rejected structural inputs", () => {
  it("rejects accessor requests without invoking or retaining them", async () => {
    const { store } = await openStore("hostile-queue-request", {
      limits: { queuedOperations: 1 },
    });
    let getterReads = 0;
    const hostile = { ...existingLoad() };
    Object.defineProperty(hostile, "currentMarkdownDigest", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return DIGEST_A;
      },
    });
    const hostileAttempt = { ...preparedAttempt() };
    Object.defineProperty(hostileAttempt, "forward", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return preparedAttempt().forward;
      },
    });
    const hostileRelocation = { ...prefixRelocation() };
    Object.defineProperty(hostileRelocation, "kind", {
      enumerable: true,
      get: () => {
        getterReads += 1;
        return "folder-prefix";
      },
    });
    const rejectedRequest = store.loadNote(hostile);
    const rejectedRecord = store.prepareForward(hostileAttempt);
    const rejectedRelocation = store.beginRelocation(hostileRelocation);
    const admitted = store.prepareForward(preparedAttempt());

    await expect(rejectedRequest).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    await expect(rejectedRecord).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    await expect(rejectedRelocation).resolves.toEqual({
      ok: false,
      code: "invalid-command",
    });
    expect(getterReads).toBe(0);
    await expect(admitted).resolves.toEqual({ ok: true, value: undefined });
    await store.dispose();
  });

  it("rejects dense and sparse hostile arrays before descriptor materialization", async () => {
    const { store } = await openStore("hostile-queue-arrays");
    for (const values of [new Array(16_384).fill(null), new Array(16_384)]) {
      await expect(
        store.loadNote({
          ...existingLoad(),
          hostileValues: values,
        } as unknown as Parameters<typeof store.loadNote>[0]),
      ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    }
    await expect(
      store.prepareForward({
        ...preparedAttempt(),
        hostileValues: new Array(1_048_576),
      } as Parameters<typeof store.prepareForward>[0]),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await store.dispose();
  });
});

function queueBase(index: number): typeof BASE {
  return {
    ...BASE,
    rawTextSha256: parseSha256Digest(index.toString(16).padStart(64, "0")),
    revision: createSidecarRevision(index),
  };
}
