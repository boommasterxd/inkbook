import type {
  NoteIdentityV1,
  RelocationId,
} from "../../application/note-session";
import {
  resolveNewSidecarPathV1,
  resolveRelocatedPath,
  type PersistenceCodecPortV1,
  type PrefixRelocationRuleV1,
  type SidecarStorageLayoutV1,
  type SidecarStoragePolicyV1,
} from "../../application/persistence";
import { normalizeVaultRelativePathV1 } from "../../application/vault-path";
import {
  loadRuntimeSidecarV1,
  type RuntimeSidecarLoadResultV1,
} from "./runtime-sidecar-load";
import type { SidecarMarkerWriter } from "./vault-sidecar/marker";
import {
  deriveSidecarPath,
  type NormalizeVaultPath,
  type VaultFileCapability,
} from "./vault-sidecar/paths";
import type { VaultSidecarRepository } from "./vault-sidecar/repository";

export interface RuntimeRelocatedSidecarEvidenceV1 {
  readonly priorSidecarPath: string;
  readonly relocationIds: readonly RelocationId[];
  readonly rules: readonly PrefixRelocationRuleV1[];
  readonly targetLayout: SidecarStorageLayoutV1;
  readonly targetSidecarPath: string;
}

export type RuntimeSidecarResolutionV1 =
  | {
      readonly kind: "blocked";
      readonly reason?: RuntimeSidecarBlockReasonV1;
    }
  | {
      readonly kind: "existing" | "unannotated";
      readonly sidecarPath: string;
      readonly relocation?: RuntimeRelocatedSidecarEvidenceV1;
    }
  | {
      readonly allowUnannotated: boolean;
      readonly candidatePaths: readonly string[];
      readonly creationPath: string;
      readonly kind: "discovery";
      readonly markerState: "false" | "legacy" | "missing";
    };

type RuntimeSidecarBlockReasonV1 =
  "invalid-locator" | "invalid-marker" | "metadata-unavailable";

export type RuntimeSidecarMetadataV1 =
  | { readonly kind: "unavailable" }
  | { readonly kind: "available"; readonly frontmatter: unknown };

type MaterializedRuntimeSidecarResolutionV1 =
  | { readonly kind: "conflict" | "drift" }
  | {
      readonly kind: "resolved";
      readonly resolution: Exclude<
        RuntimeSidecarResolutionV1,
        { readonly kind: "discovery" }
      >;
    };

export function resolveRuntimeSidecarMarkerV1(options: {
  readonly identity: NoteIdentityV1;
  readonly metadata: RuntimeSidecarMetadataV1;
  readonly normalizePath: NormalizeVaultPath;
  readonly policy: SidecarStoragePolicyV1;
}): RuntimeSidecarResolutionV1 {
  if (options.metadata.kind === "unavailable") {
    return { kind: "blocked", reason: "metadata-unavailable" };
  }
  const frontmatter = options.metadata.frontmatter;
  if (frontmatter !== undefined && !isRecord(frontmatter)) {
    return { kind: "blocked", reason: "invalid-marker" };
  }
  const fields = frontmatter;
  const marker = fields?.["inkbook-annotations"];
  const locator = fields?.["inkbook-sidecar"];
  const located = normalizeLocator(locator, options.normalizePath);
  if (located.kind === "invalid") {
    return { kind: "blocked", reason: "invalid-locator" };
  }
  if (marker === true && located.path !== null) {
    return { kind: "existing", sidecarPath: located.path };
  }
  if (marker !== undefined && marker !== true && marker !== false) {
    return { kind: "blocked", reason: "invalid-marker" };
  }
  const candidatePaths =
    located.path === null
      ? deterministicCandidatePaths(options)
      : Object.freeze([located.path]);
  let markerState: "false" | "legacy" | "missing" = "missing";
  if (marker === true) markerState = "legacy";
  else if (marker === false) markerState = "false";
  return Object.freeze({
    allowUnannotated: marker === undefined && located.path === null,
    candidatePaths,
    creationPath: resolveNewSidecarPathV1(
      options.policy,
      options.identity.vaultRelativeMarkdownPath,
      { normalizePath: options.normalizePath },
    ),
    kind: "discovery",
    markerState,
  });
}

export async function materializeRuntimeSidecarResolutionV1(options: {
  readonly identity: NoteIdentityV1;
  readonly marker: SidecarMarkerWriter;
  readonly noteFile: VaultFileCapability | null;
  readonly persistenceCodecPort: PersistenceCodecPortV1;
  readonly repository: VaultSidecarRepository;
  readonly resolution: RuntimeSidecarResolutionV1;
  readonly normalizePath: NormalizeVaultPath;
}): Promise<MaterializedRuntimeSidecarResolutionV1> {
  if (options.resolution.kind !== "discovery") {
    return { kind: "resolved", resolution: options.resolution };
  }
  const validPaths: string[] = [];
  let invalidCandidate = false;
  for (const path of options.resolution.candidatePaths) {
    const loaded = await loadRuntimeSidecarV1(
      options.repository,
      path,
      options.persistenceCodecPort,
    );
    if (loaded.kind === "absent") continue;
    if (loaded.kind !== "current" || !matchesIdentity(loaded, options)) {
      invalidCandidate = true;
      continue;
    }
    validPaths.push(path);
  }
  if (validPaths.length > 1) return { kind: "conflict" };
  const validPath = validPaths[0];
  if (options.resolution.markerState === "legacy") {
    if (validPath === undefined) {
      return { kind: invalidCandidate ? "conflict" : "drift" };
    }
    if (options.noteFile === null) return { kind: "drift" };
    const adopted = await options.marker.adoptLegacyLocator(
      options.noteFile,
      validPath,
    );
    return adopted.kind === "acknowledged"
      ? {
          kind: "resolved",
          resolution: { kind: "existing", sidecarPath: validPath },
        }
      : { kind: "drift" };
  }
  if (options.resolution.markerState === "false") return { kind: "drift" };
  if (validPath !== undefined || invalidCandidate) {
    return { kind: validPath === undefined ? "conflict" : "drift" };
  }
  if (!options.resolution.allowUnannotated) return { kind: "drift" };
  return {
    kind: "resolved",
    resolution: {
      kind: "unannotated",
      sidecarPath: options.resolution.creationPath,
    },
  };
}

function deterministicCandidatePaths(options: {
  readonly identity: NoteIdentityV1;
  readonly normalizePath: NormalizeVaultPath;
  readonly policy: SidecarStoragePolicyV1;
}): readonly string[] {
  const policies: SidecarStoragePolicyV1[] = [
    { mode: "adjacent", version: 1 },
    options.policy,
  ];
  return Object.freeze([
    ...new Set(
      policies.map((policy) =>
        resolveNewSidecarPathV1(
          policy,
          options.identity.vaultRelativeMarkdownPath,
          { normalizePath: options.normalizePath },
        ),
      ),
    ),
  ]);
}

function normalizeLocator(
  locator: unknown,
  normalizePath: NormalizeVaultPath,
):
  | { readonly kind: "valid"; readonly path: string | null }
  | {
      readonly kind: "invalid";
    } {
  if (locator === undefined) return { kind: "valid", path: null };
  if (typeof locator !== "string") return { kind: "invalid" };
  try {
    return {
      kind: "valid",
      path: normalizeVaultRelativePathV1(locator, {
        normalizePath,
        requiredSuffix: ".inkbook.json",
      }),
    };
  } catch {
    return { kind: "invalid" };
  }
}

function matchesIdentity(
  loaded: Extract<RuntimeSidecarLoadResultV1, { readonly kind: "current" }>,
  options: {
    readonly identity: NoteIdentityV1;
    readonly normalizePath: NormalizeVaultPath;
  },
): boolean {
  try {
    return (
      loaded.sidecar.noteIdentity.vaultRelativeMarkdownPath ===
        options.identity.vaultRelativeMarkdownPath &&
      deriveSidecarPath(
        options.identity.vaultRelativeMarkdownPath,
        loaded.sidecar.storageLayout,
        options.normalizePath,
      ) === loaded.file.path
    );
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveRuntimeRelocatedSidecarV1(options: {
  readonly getFile: (path: string) => VaultFileCapability | null;
  readonly identity: NoteIdentityV1;
  readonly policy: SidecarStoragePolicyV1;
  readonly resolution: RuntimeSidecarResolutionV1;
  readonly rules: readonly PrefixRelocationRuleV1[] | null;
}): RuntimeSidecarResolutionV1 {
  if (options.resolution.kind !== "existing") return options.resolution;
  if (options.rules === null) return { kind: "blocked" };
  const sourcePath = options.resolution.sidecarPath;
  const rules = options.rules;
  const policies: SidecarStoragePolicyV1[] = [
    { mode: "adjacent", version: 1 },
    ...(options.policy.mode === "vault-root" ? [options.policy] : []),
  ];
  const matches = policies.flatMap((candidate) => {
    const target = resolveNewSidecarPathV1(
      candidate,
      options.identity.vaultRelativeMarkdownPath,
    );
    const relocated = resolveRelocatedPath(sourcePath, target, rules);
    return options.getFile(target) !== null && relocated.ok
      ? [{ candidate, relocated: relocated.value, target }]
      : [];
  });
  const match = matches.length === 1 ? matches[0] : undefined;
  return match === undefined
    ? { kind: "blocked" }
    : {
        kind: "existing",
        relocation: Object.freeze({
          priorSidecarPath: sourcePath,
          relocationIds: match.relocated.relocationIds,
          rules,
          targetLayout: storageLayout(match.candidate),
          targetSidecarPath: match.target,
        }),
        sidecarPath: match.target,
      };
}

function storageLayout(policy: SidecarStoragePolicyV1): SidecarStorageLayoutV1 {
  return policy.mode === "adjacent"
    ? { kind: "adjacent" }
    : { kind: "vault-root", vaultRelativeRoot: policy.vaultRelativeRoot };
}
