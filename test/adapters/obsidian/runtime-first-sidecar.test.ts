import { describe, expect, it } from "vitest";

import type { PrepareHostEffectRequestV1 } from "../../../src/application/host-history/types";
import type { CommandResultV1 } from "../../../src/application/note-session";
import {
  PersistencePermitPool,
  type FirstSidecarSourceEvidenceV1,
  type PersistenceCodecPortV1,
  type PersistenceCodecSubmissionV1,
} from "../../../src/application/persistence";
import { executePersistenceCodecProcessor } from "../../application/persistence/support";
import type { SidecarRecoveryAcknowledgementV1 } from "../../../src/application/recovery";
import { decodeInkbookSidecarV1 } from "../../../src/application/persistence";
import {
  createRuntimeFirstSidecarV1,
  type RuntimeFirstSidecarOptionsV1,
} from "../../../src/adapters/obsidian/runtime-first-sidecar";
import { SidecarMarkerWriter } from "../../../src/adapters/obsidian/vault-sidecar/marker";
import { VaultSidecarRepository } from "../../../src/adapters/obsidian/vault-sidecar/repository";
import { ImmediateSourceDigestWorkPort } from "../../application/source-coordination/support";
import {
  COMMAND,
  EVIDENCE,
  createDeferred,
  createFirstSidecarHarness,
  hostForwardAttempt,
} from "../../application/persistence/first-sidecar-support";
import {
  FakeFrontMatterHost,
  FakeVault,
  fakeFile,
} from "./vault-sidecar/support";

const FIXED_SAVED_AT = 1_755_734_400_000;

describe("runtime first-sidecar composition", () => {
  it("creates the complete canonical revision one through the worker codec", async () => {
    const fixture = createFixture();

    await expect(
      fixture.runtime.prepare(fixture.request),
    ).resolves.toMatchObject({
      dispatch: "host-forward",
      kind: "prepared",
    });
    expect(fixture.frontmatter.frontmatter).toEqual({
      "inkbook-annotations": true,
      "inkbook-sidecar": COMMAND.expectedVaultRelativePath,
      preserved: "value",
    });
    await fixture.harness.publishHostForward();

    await expect(
      fixture.runtime.recordHostForward(fixture.attempt),
    ).resolves.toEqual({ kind: "acknowledged" });

    expect(fixture.codec.submissions).toBe(1);
    expect(fixture.vault.createCalls).toBe(1);
    const rawText = fixture.vault.texts.get(COMMAND.expectedVaultRelativePath);
    expect(rawText?.endsWith("\n")).toBe(true);
    const decoded = decodeInkbookSidecarV1(requiredText(rawText));
    expect(decoded.kind).toBe("current");
    if (decoded.kind !== "current") return;
    expect(decoded.sidecar).toMatchObject({
      baseRevision: null,
      revision: 1,
      savedAtEpochMs: FIXED_SAVED_AT,
      scene: { revision: 1 },
    });
    expect(decoded.sidecar.scene.elements).toHaveLength(1);
    expect(fixture.acknowledgements).toHaveLength(1);
    expect(fixture.acknowledgements[0]).toMatchObject({
      acknowledgedReplacementBase: { revision: 1 },
      coveredAttemptIds: [fixture.attempt.attemptId],
      coveredCheckpointIds: [EVIDENCE.checkpointId],
      expectedPriorBase: { rawTextSha256: null, revision: null },
    });
    await fixture.runtime.dispose();
  });

  it("leaves the complete revision one intact when recovery acknowledgement crashes", async () => {
    const fixture = createFixture({ acknowledge: false });
    await expect(
      fixture.runtime.prepare(fixture.request),
    ).resolves.toMatchObject({ kind: "prepared" });
    await fixture.harness.publishHostForward();

    await expect(
      fixture.runtime.recordHostForward(fixture.attempt),
    ).resolves.toEqual({ kind: "drift" });

    const rawText = requiredText(
      fixture.vault.texts.get(COMMAND.expectedVaultRelativePath),
    );
    const decoded = decodeInkbookSidecarV1(rawText);
    expect(decoded.kind).toBe("current");
    if (decoded.kind !== "current") return;
    expect(decoded.sidecar.revision).toBe(1);
    expect(decoded.sidecar.baseRevision).toBeNull();
    expect(decoded.sidecar.scene.elements).toHaveLength(1);
    await expect(
      fixture.runtime.recordHostForward(fixture.attempt),
    ).resolves.toEqual({ kind: "rejected" });
    expect(fixture.vault.createCalls).toBe(1);
    await fixture.runtime.dispose();
  });

  it("creates no visible sidecar when disposal wins after the marker write", async () => {
    const checkpoint = createDeferred<FirstSidecarSourceEvidenceV1 | null>();
    const fixture = createFixture({ checkpoint: checkpoint.promise });
    const preparation = fixture.runtime.prepare(fixture.request);
    await Promise.resolve();
    expect(fixture.frontmatter.frontmatter["inkbook-annotations"]).toBe(true);

    await fixture.runtime.dispose();
    await expect(preparation).resolves.toEqual({ kind: "drift" });
    checkpoint.resolve(EVIDENCE);
    await Promise.resolve();

    expect(fixture.codec.submissions).toBe(0);
    expect(fixture.vault.createCalls).toBe(0);
    expect(fixture.vault.texts.has(COMMAND.expectedVaultRelativePath)).toBe(
      false,
    );
  });

  it("rejects a checkpoint that did not observe the marker transition", async () => {
    const fixture = createFixture({ checkpoint: Promise.resolve(EVIDENCE) });

    await expect(fixture.runtime.prepare(fixture.request)).resolves.toEqual({
      kind: "drift",
    });
    expect(fixture.codec.submissions).toBe(0);
    expect(fixture.vault.createCalls).toBe(0);
    await fixture.runtime.dispose();
  });
});

interface Fixture {
  readonly acknowledgements: SidecarRecoveryAcknowledgementV1[];
  readonly attempt: ReturnType<typeof hostForwardAttempt>;
  readonly codec: ImmediatePersistenceCodec;
  readonly frontmatter: FakeFrontMatterHost;
  readonly harness: ReturnType<typeof createFirstSidecarHarness>;
  readonly request: PrepareHostEffectRequestV1;
  readonly runtime: ReturnType<typeof createRuntimeFirstSidecarV1<string>>;
  readonly vault: FakeVault;
}

function createFixture(
  options: {
    readonly acknowledge?: boolean;
    readonly checkpoint?: Promise<FirstSidecarSourceEvidenceV1 | null>;
  } = {},
): Fixture {
  const harness = createFirstSidecarHarness();
  const attempt = hostForwardAttempt();
  const request = requestFromAttempt(attempt);
  const vault = new FakeVault();
  const frontmatter = new FakeFrontMatterHost({ preserved: "value" });
  const codec = new ImmediatePersistenceCodec();
  const acknowledgements: SidecarRecoveryAcknowledgementV1[] = [];
  const runtimeOptions: RuntimeFirstSidecarOptionsV1<string> = {
    acknowledgeRecovery: {
      acknowledgeSidecar: async (acknowledgement) => {
        acknowledgements.push(acknowledgement);
        return acknowledgementResult(options.acknowledge !== false);
      },
    },
    awaitObservedMarkerCheckpoint: async (_signal, correlation) => {
      expect(correlation).toMatchObject({
        command: COMMAND,
        priorSourceGeneration: 1,
      });
      if (options.checkpoint !== undefined) return options.checkpoint;
      await harness.acknowledgeCheckpoint();
      return EVIDENCE;
    },
    marker: new SidecarMarkerWriter(frontmatter),
    nowEpochMs: () => FIXED_SAVED_AT,
    permits: new PersistencePermitPool("desktop-tablet"),
    persistenceCodecPort: codec,
    prepareDispatch: async (candidate) =>
      candidate === request
        ? {
            dispatch: "host-forward",
            kind: "prepared",
            recoveryAttemptId: attempt.attemptId,
          }
        : { kind: "rejected" },
    readContext: () => ({
      expectedSettingsRevision: COMMAND.expectedSettingsRevision,
      expectedVaultRelativePath: COMMAND.expectedVaultRelativePath,
      noteIdentity: COMMAND.noteIdentity,
      storageLayout: COMMAND.storageLayout,
    }),
    readNoteFile: () =>
      fakeFile(COMMAND.noteIdentity.vaultRelativeMarkdownPath),
    readRelocationGate: () => ({
      activeStorageRootRelocation: null,
      policyCreationBlocked: false,
    }),
    repository: new VaultSidecarRepository(vault),
    revalidateSource: (evidence, snapshot) =>
      evidence.checkpointId === EVIDENCE.checkpointId &&
      evidence.generation === EVIDENCE.generation &&
      evidence.digest === EVIDENCE.digest &&
      snapshot.source.kind === "durable" &&
      snapshot.source.generation === EVIDENCE.generation &&
      snapshot.source.digest === EVIDENCE.digest,
    session: harness.session,
    sourceDigestWorkPort: new ImmediateSourceDigestWorkPort(),
    writableTier: "desktop-tablet",
  };
  return Object.freeze({
    acknowledgements,
    attempt,
    codec,
    frontmatter,
    harness,
    request,
    runtime: createRuntimeFirstSidecarV1(runtimeOptions),
    vault,
  });
}

class ImmediatePersistenceCodec implements PersistenceCodecPortV1 {
  public submissions = 0;

  public submit(
    work: Parameters<PersistenceCodecPortV1["submit"]>[0],
  ): PersistenceCodecSubmissionV1 {
    this.submissions += 1;
    return Object.freeze({
      cancel: (): void => undefined,
      result: Promise.resolve(executePersistenceCodecProcessor(work)),
    });
  }
}

function requestFromAttempt(
  attempt: ReturnType<typeof hostForwardAttempt>,
): PrepareHostEffectRequestV1 {
  return Object.freeze({
    effectId: attempt.acknowledgement.effectId,
    historyEntry: Object.freeze({
      forward: attempt.forward,
      historyEntryId: attempt.historyEntryId,
      historyEpoch: attempt.historyEpoch,
      inverse: attempt.inverse,
    }),
    operationId: attempt.operationId,
    viewId: attempt.acknowledgement.editorViewId,
  });
}

function acknowledgementResult(ok: boolean): CommandResultV1<void> {
  return ok
    ? { ok: true, value: undefined }
    : { code: "recovery-unavailable", ok: false };
}

function requiredText(value: string | undefined): string {
  if (value === undefined) throw new Error("Expected a created sidecar.");
  return value;
}
