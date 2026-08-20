import {
  commandFailure,
  commandSuccess,
  createSidecarRevision,
  parseRelocationId,
  type CommandResultV1,
  type RelocationId,
  type Sha256Digest,
} from "../../application/note-session";
import {
  beginFileRelocation,
  createPersistenceEncodeWorkV1,
  PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
  resolveRelocatedPath,
  resumeFileRelocation,
  SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1,
  type FileRelocationPortsV1,
  type InkbookSidecarV1,
} from "../../application/persistence";
import type {
  FileRelocationRecordV1,
  RelocationRecordV1,
} from "../../application/recovery";
import { sha256Bytes } from "../../domain/codecs/sha256";
import type {
  RuntimePersistenceOpenOptionsV1,
  RuntimeRelocatedSidecarEvidenceV1,
} from "./runtime-persistence-open";
import {
  loadRuntimeSidecarV1,
  type RuntimeSidecarLoadResultV1,
} from "./runtime-sidecar-load";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import { deriveSidecarPath } from "./vault-sidecar/paths";
import type {
  PreparedSidecarWrite,
  VaultSidecarRepository,
} from "./vault-sidecar/repository";

type CurrentSidecar = Extract<
  RuntimeSidecarLoadResultV1,
  { readonly kind: "current" }
>;

export async function repairRelocatedSidecarV1(options: {
  readonly digestText: (value: string) => Promise<Sha256Digest | null>;
  readonly evidence: RuntimeRelocatedSidecarEvidenceV1;
  readonly loaded: CurrentSidecar;
  readonly markdownDigest: Sha256Digest;
  readonly marker: SidecarMarkerWriter;
  readonly open: RuntimePersistenceOpenOptionsV1;
  readonly repository: VaultSidecarRepository;
}): Promise<CurrentSidecar | null> {
  const relocationId = await repairRelocationIdV1(options.evidence);
  const prior = await options.open.recovery.loadRelocationById({
    relocationId,
  });
  if (!prior.ok || (prior.value !== null && !isFileRelocation(prior.value)))
    return null;
  const initial = prior.value ?? (await initialRecord(options, relocationId));
  if (initial === null) return null;
  const ports = repairPorts(options);
  const repaired =
    prior.value === null
      ? await beginFileRelocation(initial, options.open.recovery, ports)
      : await resumeFileRelocation(initial, options.open.recovery, ports);
  if (!repaired.ok) return null;
  const reloaded = await loadRuntimeSidecarV1(
    options.repository,
    options.evidence.targetSidecarPath,
    options.open.persistenceCodecPort,
  );
  return reloaded.kind === "current" && matchesTarget(reloaded, options)
    ? reloaded
    : null;
}

async function initialRecord(
  options: Parameters<typeof repairRelocatedSidecarV1>[0],
  relocationId: RelocationId,
): Promise<FileRelocationRecordV1 | null> {
  const sidecar = options.loaded.sidecar;
  const priorMarkdownPath = sidecar.noteIdentity.vaultRelativeMarkdownPath;
  const route = resolveRelocatedPath(
    priorMarkdownPath,
    options.open.identity.vaultRelativeMarkdownPath,
    options.evidence.rules,
  );
  if (
    !route.ok ||
    sidecar.noteIdentity.markdownContentDigest !== options.markdownDigest ||
    !matchesPrior(options.loaded, options)
  )
    return null;
  const rawDigest = await options.digestText(options.loaded.rawText);
  if (rawDigest === null) return null;
  return Object.freeze({
    destinationMarkdownPath: options.open.identity.vaultRelativeMarkdownPath,
    destinationSidecarPath: options.evidence.targetSidecarPath,
    expectedSceneRevision: sidecar.scene.revision,
    expectedSettingsRevision: options.open.settingsRevision,
    kind:
      priorMarkdownPath === options.open.identity.vaultRelativeMarkdownPath
        ? "sidecar-location"
        : "markdown-file",
    noteIdentity: {
      vaultIdHint: options.open.identity.vaultIdHint,
      vaultRelativeMarkdownPath: priorMarkdownPath,
    },
    relocationId,
    sidecarBase: {
      markdownPath: priorMarkdownPath,
      rawTextSha256: rawDigest,
      revision: createSidecarRevision(sidecar.revision),
      vaultRelativePath: options.evidence.priorSidecarPath,
    },
    sourceMarkdownPath: priorMarkdownPath,
    sourceSidecarPath: options.evidence.priorSidecarPath,
    step: "prepared",
  });
}

function repairPorts(
  options: Parameters<typeof repairRelocatedSidecarV1>[0],
): FileRelocationPortsV1 {
  return {
    admitMutations: async () => commandSuccess(undefined),
    awaitSourceCheckpoint: async () => commandSuccess(undefined),
    rekeyOwnedIdentities: async () => commandSuccess(undefined),
    saveMarker: async (): Promise<CommandResultV1<void>> => {
      const note = options.open.resolveMarkdownFile(
        options.open.identity.vaultRelativeMarkdownPath,
      );
      if (note === null) return commandFailure("sidecar-conflict");
      const saved = await options.marker.compareAndSetLocator(
        note,
        options.evidence.priorSidecarPath,
        options.evidence.targetSidecarPath,
      );
      return saved.kind === "acknowledged"
        ? commandSuccess(undefined)
        : commandFailure("sidecar-conflict");
    },
    saveSidecarMetadata: async () => saveMetadata(options),
    settleSaveAndMoveSidecar: async () =>
      options.loaded.file.path === options.evidence.targetSidecarPath
        ? commandSuccess(undefined)
        : commandFailure("sidecar-conflict"),
  };
}

async function saveMetadata(
  options: Parameters<typeof repairRelocatedSidecarV1>[0],
): Promise<CommandResultV1<void>> {
  if (matchesTarget(options.loaded, options)) return commandSuccess(undefined);
  if (!matchesPrior(options.loaded, options))
    return commandFailure("sidecar-conflict");
  const current = options.loaded.sidecar;
  const sidecar: InkbookSidecarV1 = {
    ...current,
    baseRevision: current.revision,
    noteIdentity: {
      ...current.noteIdentity,
      vaultRelativeMarkdownPath:
        options.open.identity.vaultRelativeMarkdownPath,
    },
    revision: current.revision + 1,
    savedAtEpochMs: Date.now(),
    storageLayout: options.evidence.targetLayout,
  };
  const prepared = await encodeMetadata(sidecar, options);
  if (prepared === null) return commandFailure("sidecar-conflict");
  const saved = await options.repository.compareAndProcess(
    options.loaded.file,
    options.loaded.rawText,
    prepared,
  );
  return saved.kind === "acknowledged"
    ? commandSuccess(undefined)
    : commandFailure("sidecar-conflict");
}

async function encodeMetadata(
  sidecar: InkbookSidecarV1,
  options: Parameters<typeof repairRelocatedSidecarV1>[0],
): Promise<PreparedSidecarWrite | null> {
  try {
    const submitted = options.open.persistenceCodecPort.submit(
      createPersistenceEncodeWorkV1(
        sidecar,
        options.open.writableTier,
        PERSISTENCE_DECODED_MEMORY_MAX_BYTES_V1,
        SIDECAR_WRITE_LIMITS_UTF8_BYTES_V1[options.open.writableTier],
      ),
    );
    const encoded = await submitted.result;
    if (encoded.kind !== "encoded-sidecar") return null;
    return Object.freeze({
      rawText: new TextDecoder("utf-8", { fatal: true }).decode(encoded.bytes),
      utf8Bytes: encoded.bytes.byteLength,
    });
  } catch {
    return null;
  }
}

function matchesPrior(
  loaded: CurrentSidecar,
  options: Parameters<typeof repairRelocatedSidecarV1>[0],
): boolean {
  try {
    return (
      loaded.file.path === options.evidence.targetSidecarPath &&
      deriveSidecarPath(
        loaded.sidecar.noteIdentity.vaultRelativeMarkdownPath,
        loaded.sidecar.storageLayout,
        options.open.vault.normalizePath,
      ) === options.evidence.priorSidecarPath
    );
  } catch {
    return false;
  }
}

function matchesTarget(
  loaded: CurrentSidecar,
  options: Parameters<typeof repairRelocatedSidecarV1>[0],
): boolean {
  return (
    loaded.sidecar.noteIdentity.vaultRelativeMarkdownPath ===
      options.open.identity.vaultRelativeMarkdownPath &&
    deriveSidecarPath(
      options.open.identity.vaultRelativeMarkdownPath,
      loaded.sidecar.storageLayout,
      options.open.vault.normalizePath,
    ) === options.evidence.targetSidecarPath
  );
}

async function repairRelocationIdV1(
  evidence: RuntimeRelocatedSidecarEvidenceV1,
): Promise<RelocationId> {
  const digest = await sha256Bytes(
    new TextEncoder().encode(
      `${evidence.relocationIds.join(":")}:${evidence.priorSidecarPath}:${evidence.targetSidecarPath}`,
    ),
  );
  return parseRelocationId(`rel_0${digest.slice(0, Number("25"))}`);
}

function isFileRelocation(
  value: RelocationRecordV1,
): value is FileRelocationRecordV1 {
  return value.kind === "markdown-file" || value.kind === "sidecar-location";
}
