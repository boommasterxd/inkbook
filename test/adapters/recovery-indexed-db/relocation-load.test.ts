/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact limits and identifiers are persistence boundary fixtures. */
import { describe, expect, it } from "vitest";

import { parseRelocationId } from "../../../src/application/note-session";
import {
  corruptStoredRecord,
  fileRelocation,
  idPayload,
  openStore,
} from "./support";

describe("IndexedDB relocation loading", () => {
  it("loads the exact durable file step after restart without a scan", async () => {
    const name = "load-relocation-restart";
    const { store, factory } = await openStore(name);
    const prepared = fileRelocation();
    const moved = fileRelocation("sidecar-moved");
    await store.beginRelocation(prepared);
    await store.advanceRelocation({ expected: prepared, replacement: moved });
    await store.dispose();

    const { store: reopened } = await openStore(name, {}, factory);
    const loaded = await reopened.loadRelocationById({
      relocationId: moved.relocationId,
    });
    expect(loaded).toEqual({ ok: true, value: moved });
    if (!loaded.ok || loaded.value === null) {
      throw new Error("Expected a durable relocation record.");
    }
    expect(Object.isFrozen(loaded.value)).toBe(true);
    expect("noteIdentity" in loaded.value).toBe(true);
    if ("noteIdentity" in loaded.value) {
      expect(Object.isFrozen(loaded.value.noteIdentity)).toBe(true);
      expect(Object.isFrozen(loaded.value.sidecarBase)).toBe(true);
    }
    await reopened.dispose();
  });

  it("returns null for an absent relocation identity", async () => {
    const { store } = await openStore("load-relocation-absent");
    await expect(
      store.loadRelocationById({
        relocationId: parseRelocationId(`rel_${idPayload(77)}`),
      }),
    ).resolves.toEqual({ ok: true, value: null });
    await store.dispose();
  });

  it("fails closed when the exact stored relocation is corrupt", async () => {
    const name = "load-relocation-corrupt";
    const { store, factory } = await openStore(name);
    const record = fileRelocation();
    await store.beginRelocation(record);
    await store.dispose();
    await corruptStoredRecord(
      factory,
      name,
      `relocation:${record.relocationId}`,
    );

    const { store: reopened } = await openStore(name, {}, factory);
    await expect(
      reopened.loadRelocationById({ relocationId: record.relocationId }),
    ).resolves.toEqual({ ok: false, code: "recovery-unavailable" });
    await reopened.dispose();
  });

  it("loads an existing record without consuming additional record quota", async () => {
    const { store } = await openStore("load-relocation-quota", {
      limits: { globalRecords: 1 },
    });
    const record = fileRelocation();
    await store.beginRelocation(record);
    await expect(
      store.beginRelocation({
        ...record,
        relocationId: parseRelocationId(`rel_${idPayload(78)}`),
      }),
    ).resolves.toEqual({ ok: false, code: "recovery-limit" });
    await expect(
      store.loadRelocationById({ relocationId: record.relocationId }),
    ).resolves.toEqual({ ok: true, value: record });
    await store.dispose();
  });

  it("rejects relocation loads after disposal", async () => {
    const { store } = await openStore("load-relocation-disposed");
    const relocationId = fileRelocation().relocationId;
    await store.dispose();
    await expect(store.loadRelocationById({ relocationId })).resolves.toEqual({
      ok: false,
      code: "disposed",
    });
  });

  it("validates the request through own data descriptors", async () => {
    const { store } = await openStore("load-relocation-descriptor");
    let getterCalls = 0;
    const accessor = Object.defineProperty({}, "relocationId", {
      enumerable: true,
      get: () => {
        getterCalls += 1;
        return fileRelocation().relocationId;
      },
    });
    await expect(
      store.loadRelocationById(accessor as { relocationId: never }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    expect(getterCalls).toBe(0);
    await expect(
      store.loadRelocationById({
        extra: true,
        relocationId: fileRelocation().relocationId,
      } as unknown as { relocationId: never }),
    ).resolves.toEqual({ ok: false, code: "invalid-command" });
    await store.dispose();
  });
});
