import type { ConfirmedSave, PreparedSave, SaveRevisionSource } from "../save-existing";
import {
  saveExistingFileFromVerifiedPreflight,
  type VerifiedExistingFilePreflight,
} from "../save-existing";
import { SaveError } from "../save-errors";
import { saveNewFile } from "../save-new";
import type {
  ExistingFilePort,
  MetadataGuardedFileRead,
  NewFilePort,
  PersistedOutputVerifier,
} from "../save-ports";
import type { VaultBase, VerifiedPersistedOutput } from "../../worker/protocol";
import { isExactPreparedOutput, sameVaultBase } from "./verification";

export type AutosaveExpectedBase =
  | {
      readonly base: Extract<VaultBase, { type: "confirmed" }>;
      readonly preflight: VerifiedExistingFilePreflight;
      readonly type: "preflight";
    }
  | { readonly base: Extract<VaultBase, { type: "missing" }>; readonly type: "missing" };

export interface AutosavePersistenceOptions {
  readonly beforeExistingWrite: ((expectedContent: string) => Promise<void>) | undefined;
  readonly expectedBase: AutosaveExpectedBase;
  readonly prepared: Omit<PreparedSave, "expectedBase">;
  readonly revisionSource: SaveRevisionSource;
  readonly vault: ExistingFilePort & Partial<NewFilePort>;
  readonly verifier: PersistedOutputVerifier;
}

interface AutosaveExpectedBaseOptions {
  readonly confirmedBase: VaultBase;
  readonly read: () => Promise<string | MetadataGuardedFileRead>;
  readonly verify: (read: string | MetadataGuardedFileRead) => Promise<VerifiedPersistedOutput>;
}

export async function resolveAutosaveExpectedBase(
  options: AutosaveExpectedBaseOptions,
): Promise<AutosaveExpectedBase> {
  if (options.confirmedBase.type === "missing") {
    return { base: options.confirmedBase, type: "missing" };
  }
  const read = await options.read();
  const content = typeof read === "string" ? read : read.content;
  const persisted = await options.verify(read);
  if (typeof read !== "string" && read.isCurrent?.() === false)
    throw new SaveError("external-conflict");
  if (!sameVaultBase(persisted, options.confirmedBase) || persisted.type !== "confirmed") {
    throw new SaveError("external-conflict");
  }
  return {
    base: options.confirmedBase,
    preflight: { base: persisted, content },
    type: "preflight",
  };
}

export async function persistPreparedOutput(
  options: AutosavePersistenceOptions,
): Promise<ConfirmedSave> {
  if (options.beforeExistingWrite !== undefined && options.expectedBase.type !== "missing") {
    await options.beforeExistingWrite(options.expectedBase.preflight.content);
  }
  const verifier = exactOrFallbackVerifier(options.prepared, options.verifier);
  if (options.expectedBase.type === "preflight") {
    return saveExistingFileFromVerifiedPreflight(
      options.prepared,
      options.expectedBase.base,
      options.expectedBase.preflight,
      options.revisionSource,
      options.vault,
      verifier,
    );
  }
  if (options.vault.create === undefined || options.vault.createAndReadBack === undefined) {
    throw new Error("New file creation is unavailable.");
  }
  const create = options.vault.create.bind(options.vault);
  const createAndReadBack = options.vault.createAndReadBack.bind(options.vault);
  return saveNewFile(
    options.prepared,
    options.revisionSource,
    {
      create,
      createAndReadBack,
      ...(options.vault.createAndReadBackForVerification === undefined
        ? {}
        : {
            createAndReadBackForVerification: options.vault.createAndReadBackForVerification.bind(
              options.vault,
            ),
          }),
      process: (path, update) => options.vault.process(path, update),
      readWithMetadataGuard: (path, maximumBytes) =>
        options.vault.readWithMetadataGuard(path, maximumBytes),
    },
    verifier,
  );
}

function exactOrFallbackVerifier(
  prepared: Omit<PreparedSave, "expectedBase">,
  fallback: PersistedOutputVerifier,
): PersistedOutputVerifier {
  return {
    verify: (content, revision, hash) =>
      isExactPreparedOutput(
        content,
        prepared.output,
        revision,
        prepared.revision,
        hash,
        prepared.outputHash,
      )
        ? Promise.resolve(true)
        : fallback.verify(content, revision, hash),
    ...(fallback.verifyRead === undefined
      ? {}
      : {
          verifyRead: (read: MetadataGuardedFileRead, revision: number, hash: string) =>
            prepared.totalBytes !== undefined &&
            read.identity.size === prepared.totalBytes &&
            isExactPreparedOutput(
              read.content,
              prepared.output,
              revision,
              prepared.revision,
              hash,
              prepared.outputHash,
            )
              ? Promise.resolve(read.isCurrent?.() !== false)
              : fallback.verifyRead!(read, revision, hash),
        }),
  };
}
