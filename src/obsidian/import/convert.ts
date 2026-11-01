import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";
import {
  createDocumentRuntime,
  DocumentWorkerRuntime,
  GestureAwareSliceScheduler,
  type DocumentRuntimePort,
} from "../../persistence/worker/runtime/public";
import type { ImportInkRuntimeRequest } from "../../persistence/worker/runtime/types";
import { adoptOwnedSvgOutput } from "../../persistence/scheduling/owned-svg-output";
import type { InkImportPorts } from "./types";

interface ImportConversionOptions {
  readonly ownerWindow: Window;
  readonly workScheduler: WorkScheduler;
  readonly frameIntervalMilliseconds: () => number;
  readonly subscribeSchedulingProfile?: (listener: () => void) => () => void;
  readonly createId: () => string;
  readonly timestamp: () => number;
}

export function createInkImportConverter(
  options: ImportConversionOptions,
): InkImportPorts["convert"] {
  return async (content, request) => {
    const signal = request.signal ?? new AbortController().signal;
    signal.throwIfAborted();
    const sessionId = `ink-import-${options.createId()}`;
    const timestamp = options.timestamp();
    let runtime: DocumentRuntimePort | undefined;
    const abort = (): void => runtime?.terminate();
    signal.addEventListener("abort", abort, { once: true });
    try {
      try {
        runtime = await createDocumentRuntime(sessionId, 1, options.ownerWindow, {
          workScheduler: options.workScheduler,
          frameIntervalMilliseconds: options.frameIntervalMilliseconds,
          requestTimeoutMilliseconds: 30_000,
          ...(options.subscribeSchedulingProfile === undefined
            ? {}
            : {
                subscribeSchedulingProfile: options.subscribeSchedulingProfile,
              }),
        });
        signal.throwIfAborted();
        const result = await convertAndVerify(
          runtime,
          {
            identity: { sessionId, workerEpoch: 1, operationId: 1, purpose: "migration" },
            input: content,
            legacyWriting: request.legacyWriting,
            timestamp,
            type: "import-ink",
          },
          signal,
        );
        if (result !== undefined) return result;
      } catch (error) {
        signal.throwIfAborted();
        if (error instanceof ImportConversionError) throw error;
      } finally {
        runtime?.terminate();
        runtime = undefined;
      }
      signal.throwIfAborted();
      runtime = new DocumentWorkerRuntime(
        { sessionId, workerEpoch: 2 },
        new GestureAwareSliceScheduler({
          isInputActive: () => false,
          workScheduler: options.workScheduler,
        }),
      );
      const result = await convertAndVerify(
        runtime,
        {
          identity: { sessionId, workerEpoch: 2, operationId: 1, purpose: "migration" },
          input: content,
          legacyWriting: request.legacyWriting,
          timestamp,
          type: "import-ink",
        },
        signal,
      );
      if (result === undefined) throw new Error("Ink import runtime failed.");
      return result;
    } finally {
      signal.removeEventListener("abort", abort);
      runtime?.terminate();
    }
  };
}

class ImportConversionError extends Error {}

async function convertAndVerify(
  runtime: DocumentRuntimePort,
  request: ImportInkRuntimeRequest,
  signal: AbortSignal,
): Promise<{ readonly svg: string; readonly warnings: readonly string[] } | undefined> {
  const result = await runtime.execute(request);
  signal.throwIfAborted();
  if (result.type === "runtime-failure") {
    if (result.code === "runtime-failure") return undefined;
    throw new ImportConversionError(result.code);
  }
  if (result.type !== "import-ink-success")
    throw new ImportConversionError("Ink import returned invalid output.");
  const output =
    typeof result.exported.output === "string"
      ? result.exported.output
      : (
          await adoptOwnedSvgOutput(result.exported.output, result.exported.outputHash, {
            checkpoint: () => runtime.checkpoint?.(signal),
            signal,
          })
        ).content;
  const verified = await runtime.execute({
    identity: { ...request.identity, operationId: 2, purpose: "verification" },
    input: output,
    ...(result.exported.totalBytes === undefined
      ? {}
      : { expectedBytes: result.exported.totalBytes }),
    type: "verify-output",
    versionPolicy: "current",
  });
  signal.throwIfAborted();
  if (
    verified.type !== "verify-output-success" ||
    verified.persisted.type !== "confirmed" ||
    verified.persisted.outputHash !== result.exported.outputHash ||
    verified.persisted.revision !== result.exported.modelRevision
  )
    throw new ImportConversionError("Ink import output verification failed.");
  return {
    svg: output,
    warnings:
      result.transcript === undefined
        ? result.warnings
        : [
            ...result.warnings,
            "The source transcript remains in the original file and import backup.",
          ],
  };
}
