import { IDBFactory } from "fake-indexeddb";
import { describe, expect, it } from "vitest";

import {
  DATABASE_SCHEMA_VERSION,
  probeIndexedDbRecovery,
} from "../../../src/adapters/recovery-indexed-db";
import { measureRecordCharge } from "../../../src/adapters/recovery-indexed-db/resource-charge";
import {
  RESOURCE_BUDGET_V1,
  RESOURCE_CATEGORIES_V1,
  ResourceCoordinatorV1,
  type ResourceBudgetProfileV1,
} from "../../../src/application/resource-coordinator";
import {
  corruptFirstAttempt,
  expectReady,
  NOTE,
  openRawDatabase,
  preparedRecord,
} from "./support";

// Deliberately exceeds the fixed probe charge while staying cheap for tests.
const BOUNDARY_PATCH_LENGTH = 4_096;
const SECOND_SESSION_ORDER = 2;
const THIRD_SESSION_ORDER = 3;
const MAX_ADMITTED_TURNS = 2;

describe("IndexedDB recovery resource admission", () => {
  it("admits the exact persistence-byte boundary and rejects one byte below", async () => {
    const record = preparedRecord(
      "boundary",
      1,
      "x".repeat(BOUNDARY_PATCH_LENGTH),
    );
    const charge = measureRecordCharge(record);
    if (charge === null) throw new Error("Expected a measurable fixture");

    const acceptedResources = coordinatorWithPersistenceBytes(
      charge.persistenceBytes,
    );
    const accepted = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-byte-at",
        indexedDb: new IDBFactory(),
        resourceCoordinator: acceptedResources,
      }),
    );
    await expect(accepted.prepareForward(record)).resolves.toMatchObject({
      kind: "written",
    });
    await accepted.dispose();
    expect(acceptedResources.snapshot().balanced).toBe(true);

    const rejectedResources = coordinatorWithPersistenceBytes(
      charge.persistenceBytes - 1,
    );
    const rejected = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-byte-above",
        indexedDb: new IDBFactory(),
        resourceCoordinator: rejectedResources,
      }),
    );
    await expect(rejected.prepareForward(record)).resolves.toEqual({
      kind: "resource-limited",
    });
    await rejected.dispose();
    expect(rejectedResources.snapshot().balanced).toBe(true);
  });

  it("bounds a burst at two admitted turns and rejects the next turn", async () => {
    const gate = deferred();
    const resources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const store = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-burst",
        faultInjector: {
          beforeCommit: () => undefined,
          beforeExecute: () => gate.promise,
        },
        indexedDb: new IDBFactory(),
        resourceCoordinator: resources,
      }),
    );
    const active = store.prepareForward(preparedRecord("first", 1));
    const queued = store.prepareForward(
      preparedRecord("second", SECOND_SESSION_ORDER),
    );
    await expect(
      store.prepareForward(preparedRecord("third", THIRD_SESSION_ORDER)),
    ).resolves.toEqual({ kind: "resource-limited" });
    expect(
      resources.snapshot().categories[RESOURCE_CATEGORIES_V1.indexedDbQueueTurn]
        ?.reserved.count,
    ).toBe(MAX_ADMITTED_TURNS);
    gate.resolve();
    await expect(Promise.all([active, queued])).resolves.toMatchObject([
      { kind: "written" },
      { kind: "written" },
    ]);
    await store.dispose();
    expect(resources.snapshot().balanced).toBe(true);
  });
});

describe("IndexedDB recovery resource release", () => {
  it("releases active and queued reservations exactly once during disposal", async () => {
    const gate = deferred();
    const resources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const store = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-disposal",
        faultInjector: {
          beforeCommit: () => undefined,
          beforeExecute: () => gate.promise,
        },
        indexedDb: new IDBFactory(),
        resourceCoordinator: resources,
      }),
    );
    const active = store.prepareForward(preparedRecord("first", 1));
    const queued = store.prepareForward(
      preparedRecord("second", SECOND_SESSION_ORDER),
    );
    const firstDisposal = store.dispose();
    expect(store.dispose()).toBe(firstDisposal);
    await expect(queued).resolves.toEqual({ kind: "disposed" });
    gate.resolve();
    await expect(active).resolves.toEqual({ kind: "disposed" });
    await firstDisposal;
    expect(resources.snapshot().balanced).toBe(true);
  });

  it("retains a bounded load completion until its owner releases it", async () => {
    const resources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const store = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-load-ownership",
        indexedDb: new IDBFactory(),
        resourceCoordinator: resources,
      }),
    );
    await store.prepareForward(preparedRecord());
    const result = await store.loadNote(NOTE);
    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") throw new Error("Expected loaded result");
    await store.dispose();
    expect(resources.snapshot().balanced).toBe(false);
    expect(result.releaseResources()).toBe(true);
    expect(result.releaseResources()).toBe(false);
    expect(resources.snapshot().balanced).toBe(true);
  });

  it("fails the probe closed when its atomic resource batch is unavailable", async () => {
    const resources = coordinatorWithPersistenceBytes(1);
    await expect(
      probeIndexedDbRecovery({
        databaseName: "resource-probe-rejection",
        indexedDb: new IDBFactory(),
        resourceCoordinator: resources,
      }),
    ).resolves.toEqual({ kind: "read-only", reason: "resource-limited" });
    expect(resources.snapshot().balanced).toBe(true);
  });
});

describe("IndexedDB recovery resource failure cleanup", () => {
  it("balances abort, quota, and corruption failure paths", async () => {
    const factory = new IDBFactory();
    const resources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    let failure: "abort" | "quota" = "abort";
    const store = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-fault-balance",
        faultInjector: {
          beforeCommit: (_operation, transaction) => {
            if (failure === "abort") transaction.abort();
            else throw new DOMException("Fixture quota", "QuotaExceededError");
          },
        },
        indexedDb: factory,
        resourceCoordinator: resources,
      }),
    );
    await expect(store.prepareForward(preparedRecord())).resolves.toEqual({
      kind: "transaction-aborted",
    });
    failure = "quota";
    await expect(store.prepareForward(preparedRecord())).resolves.toEqual({
      kind: "quota-exceeded",
    });
    await store.dispose();
    expect(resources.snapshot().balanced).toBe(true);

    const corruptionResources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const restarted = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-corruption-balance",
        indexedDb: factory,
        resourceCoordinator: corruptionResources,
      }),
    );
    await restarted.prepareForward(preparedRecord());
    const database = await openRawDatabase(
      factory,
      "resource-corruption-balance",
      DATABASE_SCHEMA_VERSION,
    );
    await corruptFirstAttempt(database);
    database.close();
    await expect(restarted.loadNote(NOTE)).resolves.toMatchObject({
      kind: "corrupt",
    });
    await restarted.dispose();
    expect(corruptionResources.snapshot().balanced).toBe(true);
  });

  it("balances the backend-loss and repeated-disposal paths", async () => {
    const factory = new IDBFactory();
    const resources = new ResourceCoordinatorV1(
      RESOURCE_BUDGET_V1.desktopOrAndroidTablet,
    );
    const store = expectReady(
      await probeIndexedDbRecovery({
        databaseName: "resource-backend-loss",
        indexedDb: factory,
        resourceCoordinator: resources,
      }),
    );
    const replacement = await openRawDatabase(
      factory,
      "resource-backend-loss",
      DATABASE_SCHEMA_VERSION + 1,
    );
    await expect(store.prepareForward(preparedRecord())).resolves.toEqual({
      kind: "backend-unavailable",
    });
    replacement.close();
    const disposal = store.dispose();
    expect(store.dispose()).toBe(disposal);
    await disposal;
    expect(resources.snapshot().balanced).toBe(true);
  });
});

function coordinatorWithPersistenceBytes(bytes: number): ResourceCoordinatorV1 {
  const base = RESOURCE_BUDGET_V1.desktopOrAndroidTablet;
  const profile: ResourceBudgetProfileV1 = {
    ...base,
    categoryLimits: {
      ...base.categoryLimits,
      [RESOURCE_CATEGORIES_V1.persistencePipeline]: {
        ...base.categoryLimits[RESOURCE_CATEGORIES_V1.persistencePipeline],
        bytes,
      },
    },
  };
  return new ResourceCoordinatorV1(profile);
}

function deferred(): { readonly promise: Promise<void>; resolve(): void } {
  let resolvePromise: (() => void) | undefined;
  const promise = new Promise<void>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (): void => resolvePromise?.(),
  };
}
