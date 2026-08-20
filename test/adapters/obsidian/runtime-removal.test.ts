/* eslint-disable @typescript-eslint/no-magic-numbers -- Exact barrier and revision values define the tested records. */
import { TFile } from "obsidian";
import { describe, expect, it } from "vitest";

import { RuntimeRemovalV1 } from "../../../src/adapters/obsidian/runtime-removal";
import {
  ANNOTATION_MARKER_KEY,
  SIDECAR_LOCATOR_KEY,
  SidecarMarkerWriter,
} from "../../../src/adapters/obsidian/vault-sidecar/marker";
import {
  REMOVAL_BARRIER_TIMEOUT_MS_V1,
  type RemovalClockV1,
} from "../../../src/application/persistence";
import {
  commandSuccess,
  createSidecarRevision,
  parseRemovalId,
  parseSha256Digest,
  type CommandResultV1,
} from "../../../src/application/note-session";
import type {
  ActiveRemovalRecoveryV1,
  RemovalRecordV1,
} from "../../../src/application/recovery";
import { createSceneRevision } from "../../../src/domain/model";
import {
  createRecoveryHarness,
  deferred,
} from "../../application/persistence/saga-support";
import { FakeFrontMatterHost } from "./vault-sidecar/support";

const NOW = 20_000;
const REMOVAL_ID = parseRemovalId("rm_00000000000000000000000000");
const OTHER_REMOVAL_ID = parseRemovalId("rm_11111111111111111111111111");
const BASE = Object.freeze({
  markdownPath: "notes/removal.md",
  rawTextSha256: parseSha256Digest("a".repeat(64)),
  revision: createSidecarRevision(1),
  vaultRelativePath: "notes/removal.inkbook.json",
});

function record(
  trashAcknowledged = false,
  deleteEventAcknowledged = false,
): RemovalRecordV1 {
  return {
    deadlineEpochMs: NOW + REMOVAL_BARRIER_TIMEOUT_MS_V1,
    deleteEventAcknowledged,
    expectedSceneRevision: createSceneRevision(1),
    kind: "annotation-removal",
    markerState: "present",
    noteIdentity: {
      vaultIdHint: "vault",
      vaultRelativeMarkdownPath: BASE.markdownPath,
    },
    removalId: REMOVAL_ID,
    sidecarBase: BASE,
    trashAcknowledged,
  };
}

class ManualClock implements RemovalClockV1 {
  readonly #timers = new Map<number, () => void>();
  #nextHandle = 1;

  public now(): number {
    return NOW;
  }

  public setTimeout(callback: () => void): unknown {
    const handle = this.#nextHandle;
    this.#nextHandle += 1;
    this.#timers.set(handle, callback);
    return handle;
  }

  public clearTimeout(handle: unknown): void {
    if (typeof handle === "number") this.#timers.delete(handle);
  }
}

interface RuntimeFixtureV1 {
  readonly frontmatter: FakeFrontMatterHost;
  readonly log: string[];
  readonly runtime: RuntimeRemovalV1;
}

function fixture(options: {
  readonly recovery: ReturnType<typeof createRecoveryHarness>["store"];
  readonly trash: Promise<void>;
}): RuntimeFixtureV1 {
  const log: string[] = [];
  const frontmatter = new FakeFrontMatterHost({
    [ANNOTATION_MARKER_KEY]: true,
    [SIDECAR_LOCATOR_KEY]: BASE.vaultRelativePath,
  });
  const callback =
    (name: string): (() => Promise<CommandResultV1<void>>) =>
    async () => {
      log.push(name);
      return commandSuccess(undefined);
    };
  const runtime = new RuntimeRemovalV1({
    callbacks: {
      clearSession: callback("clear-session"),
      handleExternalDelete: callback("external-delete"),
      resolveFailure: callback("resolve-failure"),
    },
    clock: new ManualClock(),
    marker: new SidecarMarkerWriter(frontmatter),
    recovery: options.recovery,
    resolveMarkdownFile: (): TFile => hostFile(BASE.markdownPath),
    trash: {
      trashSidecar: async (): Promise<void> => {
        log.push("trash");
        await options.trash;
      },
    },
  });
  return { frontmatter, log, runtime };
}

describe("runtime annotation removal", () => {
  it("registers the removal ID before durable start and accepts delete first", async () => {
    const recovery = createRecoveryHarness();
    const beginGate = deferred<undefined>();
    const trashGate = deferred<undefined>();
    const durableBegin = recovery.store.beginRemoval.bind(recovery.store);
    recovery.store.beginRemoval = async (
      value,
    ): Promise<CommandResultV1<void>> => {
      await beginGate.promise;
      return durableBegin(value);
    };
    const value = fixture({
      recovery: recovery.store,
      trash: trashGate.promise,
    });

    const starting = value.runtime.start(record());
    const deleting = value.runtime.acceptDeleteEvent({
      removalId: REMOVAL_ID,
      sidecarBase: BASE,
    });
    beginGate.resolve(undefined);

    await expect(starting).resolves.toEqual({ ok: true, value: undefined });
    await expect(deleting).resolves.toEqual({
      consumed: true,
      reason: "accepted",
    });
    expect(value.log).toEqual(["trash"]);

    trashGate.resolve(undefined);
    await value.runtime.whenIdle();
    expect(value.log).toEqual(["trash", "clear-session"]);
    expect(value.frontmatter.frontmatter).toEqual({});
    expect(recovery.removals.size).toBe(0);
  });

  it("completes the order-independent barrier after trash acknowledgement", async () => {
    const recovery = createRecoveryHarness();
    const value = fixture({
      recovery: recovery.store,
      trash: Promise.resolve(),
    });

    await expect(value.runtime.start(record())).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await value.runtime.whenIdle();
    expect(value.frontmatter.frontmatter).toHaveProperty(ANNOTATION_MARKER_KEY);
    await expect(
      value.runtime.acceptDeleteEvent({
        removalId: REMOVAL_ID,
        sidecarBase: BASE,
      }),
    ).resolves.toEqual({ consumed: true, reason: "accepted" });

    expect(value.frontmatter.frontmatter).toEqual({});
    expect(recovery.removals.size).toBe(0);
  });

  it("routes a stale removal ID through external deletion and invalidates the owner", async () => {
    const recovery = createRecoveryHarness();
    const trashGate = deferred<undefined>();
    const value = fixture({
      recovery: recovery.store,
      trash: trashGate.promise,
    });
    await value.runtime.start(record());

    await expect(
      value.runtime.acceptDeleteEvent({
        removalId: OTHER_REMOVAL_ID,
        sidecarBase: BASE,
      }),
    ).resolves.toEqual({ consumed: false, reason: "mismatch" });
    expect(value.log).toEqual(["trash", "resolve-failure", "external-delete"]);
    expect(value.frontmatter.frontmatter).toHaveProperty(ANNOTATION_MARKER_KEY);

    trashGate.resolve(undefined);
    await value.runtime.whenIdle();
  });
});

describe("runtime annotation removal restart", () => {
  it("resumes the exact durable cleanup without trashing again", async () => {
    const recovery = createRecoveryHarness();
    const durable = record(true, true);
    await recovery.store.beginRemoval(durable);
    const value = fixture({
      recovery: recovery.store,
      trash: Promise.resolve(),
    });

    await expect(value.runtime.resume(bundle(durable))).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await value.runtime.whenIdle();

    expect(value.log).toEqual(["clear-session"]);
    expect(value.frontmatter.frontmatter).toEqual({});
    expect(recovery.removals.size).toBe(0);
  });

  it("resumes a one-signal barrier and accepts the matching active delete", async () => {
    const recovery = createRecoveryHarness();
    const durable = record(true, false);
    await recovery.store.beginRemoval(durable);
    const value = fixture({
      recovery: recovery.store,
      trash: Promise.resolve(),
    });

    await expect(value.runtime.resume(bundle(durable))).resolves.toEqual({
      ok: true,
      value: undefined,
    });
    await expect(value.runtime.acceptActiveDelete(BASE)).resolves.toEqual({
      consumed: true,
      reason: "accepted",
    });

    expect(value.log).toEqual(["clear-session"]);
    expect(recovery.removals.size).toBe(0);
  });
});

function hostFile(path: string): TFile {
  const file = Object.create(TFile.prototype) as TFile;
  Object.defineProperties(file, {
    path: { value: path },
    stat: { value: { ctime: 0, mtime: 0, size: 0 } },
  });
  return file;
}

function bundle(removal: RemovalRecordV1): ActiveRemovalRecoveryV1 {
  return Object.freeze({ attempts: [], checkpoints: [], removal });
}
