import { sha256Bytes } from "../../domain/codecs/sha256";
import { commandFailure, commandSuccess } from "../note-session/results";
import type { CommandResultV1 } from "../note-session/types";
import { parseSha256Digest } from "../note-session/value-objects";
import {
  encodeRecoveryRecordV1,
  type FileRelocationRecordV1,
  type PrefixRelocationPlanV1,
  type PrefixRelocationRecordV1,
  type RecoveryStore,
} from "../recovery";

const FILE_STEP_LIMIT = 7;
export {
  deriveRelocatedStorageRootV1,
  RELOCATION_LIMITS_V1,
  resolveRelocatedPath,
  type PrefixRelocationRuleV1,
} from "./relocation-resolver";
import { RELOCATION_LIMITS_V1 } from "./relocation-resolver";

type AsyncResult = Promise<CommandResultV1<void>>;

export interface FileRelocationPortsV1 {
  settleSaveAndMoveSidecar(record: FileRelocationRecordV1): AsyncResult;
  rekeyOwnedIdentities(record: FileRelocationRecordV1): AsyncResult;
  saveSidecarMetadata(record: FileRelocationRecordV1): AsyncResult;
  saveMarker(record: FileRelocationRecordV1): AsyncResult;
  awaitSourceCheckpoint(record: FileRelocationRecordV1): AsyncResult;
  admitMutations(record: FileRelocationRecordV1): AsyncResult;
}

export interface PrefixRelocationPortsV1 {
  /**
   * Atomically validates, reserves, and durably stores the complete canonical
   * member plan before any member mutation. A restart loads the same ordinals.
   */
  loadOrPrepareDurablePlan(
    record: PrefixRelocationRecordV1,
  ): Promise<CommandResultV1<PrefixRelocationPlanV1>>;
  /** Idempotently completes the exact ordinal through its member file saga. */
  processPlannedEntry(
    record: PrefixRelocationRecordV1,
    plan: PrefixRelocationPlanV1,
    ordinal: number,
  ): AsyncResult;
  admitMutations(record: PrefixRelocationRecordV1): AsyncResult;
}
export type { PrefixRelocationPlanV1 } from "../recovery";

export interface FirstSidecarRelocationGateV1 {
  readonly policyCreationBlocked: boolean;
  readonly activeStorageRootRelocation: PrefixRelocationRecordV1 | null;
}

export function canAdmitFirstSidecarCreation(
  gate: FirstSidecarRelocationGateV1,
): boolean {
  return (
    !gate.policyCreationBlocked && gate.activeStorageRootRelocation === null
  );
}

export async function beginFileRelocation(
  record: FileRelocationRecordV1,
  recovery: RecoveryStore,
  ports: FileRelocationPortsV1,
): Promise<CommandResultV1<void>> {
  const started = await invoke(() => recovery.beginRelocation(record));
  return started.ok ? resumeFileRelocation(record, recovery, ports) : started;
}

export async function resumeFileRelocation(
  record: FileRelocationRecordV1,
  recovery: RecoveryStore,
  ports: FileRelocationPortsV1,
): Promise<CommandResultV1<void>> {
  let current = record;
  for (let index = 0; index < FILE_STEP_LIMIT; index += 1) {
    if (current.step === "complete") {
      return completeRelocation(current, recovery, (terminal) =>
        ports.admitMutations(terminal),
      );
    }
    const advanced = await advanceFileStep(current, recovery, ports);
    if (!advanced.ok) return advanced;
    current = advanced.value;
  }
  return commandFailure("relocation-pending");
}

export async function beginPrefixRelocation(
  record: PrefixRelocationRecordV1,
  batchSize: number,
  recovery: RecoveryStore,
  ports: PrefixRelocationPortsV1,
): Promise<CommandResultV1<PrefixRelocationRecordV1>> {
  if (!validPrefixPlanSize(record)) return commandFailure("resource-limit");
  const started = await invoke(() => recovery.beginRelocation(record));
  return started.ok
    ? resumePrefixRelocation(record, batchSize, recovery, ports)
    : started;
}

export async function resumePrefixRelocation(
  record: PrefixRelocationRecordV1,
  batchSize: number,
  recovery: RecoveryStore,
  ports: PrefixRelocationPortsV1,
): Promise<CommandResultV1<PrefixRelocationRecordV1>> {
  if (!validPrefixPlanSize(record)) return commandFailure("resource-limit");
  if (!validBatchSize(batchSize)) return commandFailure("invalid-command");
  if (record.step === "complete") {
    const completed = await completeRelocation(record, recovery, (terminal) =>
      ports.admitMutations(terminal),
    );
    return completed.ok ? commandSuccess(record) : completed;
  }
  return processPrefixBatch(record, batchSize, recovery, ports);
}

async function advanceFileStep(
  current: FileRelocationRecordV1,
  recovery: RecoveryStore,
  ports: FileRelocationPortsV1,
): Promise<CommandResultV1<FileRelocationRecordV1>> {
  switch (current.step) {
    case "prepared":
      return runFileEffect(current, "sidecar-moved", recovery, () =>
        ports.settleSaveAndMoveSidecar(current),
      );
    case "sidecar-moved":
      return advanceIdentityStep(current, recovery, ports);
    case "identities-rekeyed":
      return runFileEffect(current, "sidecar-metadata-saved", recovery, () =>
        ports.saveSidecarMetadata(current),
      );
    case "sidecar-metadata-saved":
      return runFileEffect(current, "marker-saved", recovery, () =>
        ports.saveMarker(current),
      );
    case "marker-saved":
      return runFileEffect(current, "checkpoint-acknowledged", recovery, () =>
        ports.awaitSourceCheckpoint(current),
      );
    case "checkpoint-acknowledged":
      return persistRelocationStep(
        current,
        { ...current, step: "complete" },
        recovery,
      );
    case "complete":
      return commandSuccess(current);
  }
}

async function advanceIdentityStep(
  current: FileRelocationRecordV1,
  recovery: RecoveryStore,
  ports: FileRelocationPortsV1,
): Promise<CommandResultV1<FileRelocationRecordV1>> {
  const rekeyed = await rekeyRecoveryForMarkdownMove(current, recovery);
  if (!rekeyed.ok) return rekeyed;
  const effect = await invoke(() => ports.rekeyOwnedIdentities(rekeyed.value));
  if (!effect.ok) return effect;
  return persistRelocationStep(
    rekeyed.value,
    { ...rekeyed.value, step: "identities-rekeyed" },
    recovery,
  );
}

async function rekeyRecoveryForMarkdownMove(
  record: FileRelocationRecordV1,
  recovery: RecoveryStore,
): Promise<CommandResultV1<FileRelocationRecordV1>> {
  if (record.kind === "sidecar-location") return commandSuccess(record);
  if (
    record.noteIdentity.vaultRelativeMarkdownPath ===
    record.destinationMarkdownPath
  ) {
    return validRekeyedRecord(record)
      ? commandSuccess(record)
      : commandFailure("sidecar-conflict");
  }
  if (
    record.noteIdentity.vaultRelativeMarkdownPath !== record.sourceMarkdownPath
  ) {
    return commandFailure("sidecar-conflict");
  }
  const replacement = rekeyedFileRecord(record);
  const result = await invoke(() =>
    recovery.rekeyNote({
      prior: record.noteIdentity,
      relocationId: record.relocationId,
      replacement: replacement.noteIdentity,
    }),
  );
  return result.ok ? commandSuccess(replacement) : result;
}

function rekeyedFileRecord(
  record: FileRelocationRecordV1,
): FileRelocationRecordV1 {
  return {
    ...record,
    noteIdentity: {
      ...record.noteIdentity,
      vaultRelativeMarkdownPath: record.destinationMarkdownPath,
    },
    sidecarBase: {
      ...record.sidecarBase,
      markdownPath: record.destinationMarkdownPath,
      vaultRelativePath: record.destinationSidecarPath,
    },
  };
}

function validRekeyedRecord(record: FileRelocationRecordV1): boolean {
  return (
    record.sidecarBase.markdownPath === record.destinationMarkdownPath &&
    record.sidecarBase.vaultRelativePath === record.destinationSidecarPath
  );
}

async function runFileEffect(
  current: FileRelocationRecordV1,
  step: FileRelocationRecordV1["step"],
  recovery: RecoveryStore,
  effect: () => AsyncResult,
): Promise<CommandResultV1<FileRelocationRecordV1>> {
  const result = await invoke(effect);
  if (!result.ok) return result;
  return persistRelocationStep(current, { ...current, step }, recovery);
}

async function persistRelocationStep<
  T extends FileRelocationRecordV1 | PrefixRelocationRecordV1,
>(
  expected: T,
  replacement: T,
  recovery: RecoveryStore,
): Promise<CommandResultV1<T>> {
  const result = await invoke(() =>
    recovery.advanceRelocation({ expected, replacement }),
  );
  return result.ok ? commandSuccess(replacement) : result;
}

async function processPrefixBatch(
  record: PrefixRelocationRecordV1,
  batchSize: number,
  recovery: RecoveryStore,
  ports: PrefixRelocationPortsV1,
): Promise<CommandResultV1<PrefixRelocationRecordV1>> {
  const planned = await invoke(() => ports.loadOrPrepareDurablePlan(record));
  if (!planned.ok) return planned;
  if (!matchesPlan(record, planned.value)) {
    return commandFailure("sidecar-conflict");
  }
  if (record.cursor === record.admittedRecordCount) {
    return persistRelocationStep(
      record,
      { ...record, step: "complete" },
      recovery,
    );
  }
  return processPlannedEntries(
    record,
    planned.value,
    batchSize,
    recovery,
    ports,
  );
}

async function processPlannedEntries(
  initial: PrefixRelocationRecordV1,
  plan: PrefixRelocationPlanV1,
  batchSize: number,
  recovery: RecoveryStore,
  ports: PrefixRelocationPortsV1,
): Promise<CommandResultV1<PrefixRelocationRecordV1>> {
  let current = initial;
  const stop = Math.min(
    current.cursor + batchSize,
    current.admittedRecordCount,
  );
  while (current.cursor < stop) {
    const processed = await invoke(() =>
      ports.processPlannedEntry(current, plan, current.cursor),
    );
    if (!processed.ok) return processed;
    const advanced = await persistRelocationStep(
      current,
      { ...current, cursor: current.cursor + 1, step: "processing" },
      recovery,
    );
    if (!advanced.ok) return advanced;
    current = advanced.value;
  }
  return commandSuccess(current);
}

function matchesPlan(
  record: PrefixRelocationRecordV1,
  plan: PrefixRelocationPlanV1,
): boolean {
  return (
    plan.relocationId === record.relocationId &&
    plan.generation === record.generation &&
    plan.admittedRecordCount === record.admittedRecordCount &&
    plan.expectedSettingsRevision === record.expectedSettingsRevision
  );
}

async function completeRelocation<
  T extends FileRelocationRecordV1 | PrefixRelocationRecordV1,
>(
  record: T,
  recovery: RecoveryStore,
  admitMutations: (record: T) => AsyncResult,
): Promise<CommandResultV1<void>> {
  const digest = await terminalDigest(record);
  if (!digest.ok) return digest;
  const completed = await invoke(() =>
    recovery.completeSaga({
      expectedTerminalRecordSha256: digest.value,
      id: record.relocationId,
      kind: "relocation",
    }),
  );
  return completed.ok ? invoke(() => admitMutations(record)) : completed;
}

async function terminalDigest(
  record: FileRelocationRecordV1 | PrefixRelocationRecordV1,
): Promise<CommandResultV1<ReturnType<typeof parseSha256Digest>>> {
  const encoded = encodeRecoveryRecordV1(record);
  if (!encoded.ok) return encoded;
  try {
    return commandSuccess(parseSha256Digest(await sha256Bytes(encoded.value)));
  } catch {
    return commandFailure("recovery-unavailable");
  }
}

function validBatchSize(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= RELOCATION_LIMITS_V1.maxPrefixBatchRecords
  );
}

function validPrefixPlanSize(record: PrefixRelocationRecordV1): boolean {
  return (
    record.admittedRecordCount <= RELOCATION_LIMITS_V1.maxPrefixPlanMembers
  );
}

async function invoke<T>(
  action: () => Promise<CommandResultV1<T>>,
): Promise<CommandResultV1<T>> {
  try {
    return await action();
  } catch {
    return commandFailure("recovery-unavailable");
  }
}
