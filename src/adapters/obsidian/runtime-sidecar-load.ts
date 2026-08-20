import {
  createPersistenceParseWorkV1,
  PersistenceDecodedBytePoolV1,
  type InkbookSidecarV1,
  type PersistenceCodecPortV1,
} from "../../application/persistence";
import type { VaultFileCapability } from "./vault-sidecar/paths";
import type {
  SidecarRawReadResult,
  VaultSidecarRepository,
} from "./vault-sidecar/repository";

const UTF16_BYTES_PER_UNIT = 2;

export type RuntimeSidecarLoadResultV1 =
  | Exclude<SidecarRawReadResult, { readonly kind: "raw" }>
  | {
      readonly kind: "current";
      readonly file: VaultFileCapability;
      readonly rawText: string;
      readonly sidecar: InkbookSidecarV1;
    }
  | {
      readonly kind: "read-only-newer-version";
      readonly file: VaultFileCapability;
      readonly rawText: string;
      readonly schemaVersion: {
        readonly major: number;
        readonly minor: number;
      };
    };

export async function loadRuntimeSidecarV1(
  repository: VaultSidecarRepository,
  path: string,
  persistenceCodecPort: PersistenceCodecPortV1,
  options: {
    readonly decodedBytes?: PersistenceDecodedBytePoolV1;
    readonly signal?: AbortSignal;
  } = {},
): Promise<RuntimeSidecarLoadResultV1> {
  const read = await repository.readRaw(path);
  if (read.kind !== "raw") return read;
  if (isAborted(options.signal)) return { kind: "cancelled" };
  const owner = (
    options.decodedBytes ?? new PersistenceDecodedBytePoolV1()
  ).tryAcquire(Math.max(1, read.rawText.length * UTF16_BYTES_PER_UNIT));
  if (owner === null) return { kind: "resource-limited" };
  const submission = persistenceCodecPort.submit(
    createPersistenceParseWorkV1(read.rawText, read.admittedUtf8Bytes, owner),
  );
  const cancel = (): void => submission.cancel();
  options.signal?.addEventListener("abort", cancel, { once: true });
  try {
    const parsed = await submission.result;
    if (isAborted(options.signal)) return { kind: "cancelled" };
    if (parsed.kind !== "parsed-sidecar") {
      return {
        kind: "invalid",
        error: new TypeError("Persistence parser returned encoded output."),
      };
    }
    return parsed.value.kind === "current"
      ? Object.freeze({
          kind: "current",
          file: read.file,
          rawText: read.rawText,
          sidecar: parsed.value.sidecar,
        })
      : Object.freeze({
          kind: "read-only-newer-version",
          file: read.file,
          rawText: read.rawText,
          schemaVersion: parsed.value.schemaVersion,
        });
  } catch (error) {
    return isAborted(options.signal)
      ? { kind: "cancelled" }
      : { kind: "invalid", error };
  } finally {
    options.signal?.removeEventListener("abort", cancel);
    owner.release();
  }
}

function isAborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}
