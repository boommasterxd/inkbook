import type { IncrementalDocumentSerializer } from "../../serialization/incremental-document-serializer";
import {
  assertScenePathIds,
  assertScenePathMaxBytes,
  assertScenePathVisibleCount,
  MAX_SCENE_PATH_BYTES,
  scenePathBytes,
  ScenePathValidationContext,
  type ValidatedScenePathBatch,
} from "./scene-path-limits";
import type { PrepareScenePathsRuntimeRequest, PreparedScenePathsRuntimeSuccess } from "./types";
import type { RuntimeWireSliceOptions } from "./element-wire-codec";
import type { SvgPathPart } from "../../../domain/geometry/svg-path-part";
import type { ScenePathOperation } from "./scene-path-operation";
import type { RuntimeSliceContext } from "./types";

export interface ScenePathProgress {
  readonly operation: ScenePathOperation;
  readonly publish?: (
    paths: PreparedScenePathsRuntimeSuccess["paths"],
    signal: AbortSignal,
  ) => Promise<void> | void;
}

export async function prepareScenePaths(
  request: PrepareScenePathsRuntimeRequest,
  context: RuntimeSliceContext,
  serializer: IncrementalDocumentSerializer,
  assertRevision: () => void,
  progress?: ScenePathProgress,
): Promise<PreparedScenePathsRuntimeSuccess["paths"]> {
  assertScenePathIds(request.ids);
  assertScenePathVisibleCount(request.visibleCount, request.ids.length);
  const maxBytes = assertScenePathMaxBytes(request.maxBytes);
  if (request.streamProgress !== undefined && typeof request.streamProgress !== "boolean")
    throw new TypeError("Invalid scene preparation progress mode.");
  assertRevision();
  const paths: { id: string; parts: readonly SvgPathPart[] }[] = [];
  let bytes = 0;
  const publisher = new ScenePathPublisher(paths, context, assertRevision, progress);
  const checkpoint = (): Promise<void> | undefined => {
    publisher.check();
    const pending = context.checkpoint();
    if (pending === undefined) return undefined;
    // Scheduler handoffs also offer complete contours between semantic boundaries.
    publisher.offer();
    return pending.then(() => publisher.check());
  };
  try {
    for (const [index, id] of request.ids.entries()) {
      if (index === request.visibleCount) publisher.prioritize();
      context.signal.throwIfAborted();
      assertRevision();
      if (progress?.operation.has(id) === false) continue;
      let parts: readonly SvgPathPart[] | undefined;
      const pathContext = progress?.operation.begin(id, { ...context, checkpoint }) ?? {
        ...context,
        checkpoint,
      };
      try {
        parts = await serializer.prepareScenePath(id, pathContext);
      } catch (error) {
        context.signal.throwIfAborted();
        if (progress?.operation.has(id) !== false) throw error;
      } finally {
        progress?.operation.finish();
      }
      assertRevision();
      if (progress?.operation.has(id) === false) continue;
      if (parts === undefined) continue;
      const nextBytes = scenePathBytes(id, parts);
      if (bytes + nextBytes > maxBytes) continue;
      bytes += nextBytes;
      paths.push({ id, parts });
      const pending = checkpoint();
      if (pending !== undefined) await pending;
    }
    await publisher.drain();
    return progress?.publish === undefined
      ? paths.filter(({ id }) => progress?.operation.has(id) !== false)
      : [];
  } finally {
    publisher.dispose();
  }
}

/** One in-flight acknowledgement never blocks centrally admitted geometry work. */
class ScenePathPublisher {
  readonly #controller = new AbortController();
  readonly #signal: AbortSignal;
  #published = 0;
  #priorityEnd: number | undefined;
  #flight: Promise<void> | undefined;
  #failed = false;
  #failure: unknown;
  public constructor(
    private readonly paths: PreparedScenePathsRuntimeSuccess["paths"],
    private readonly context: RuntimeSliceContext,
    private readonly assertRevision: () => void,
    private readonly progress: ScenePathProgress | undefined,
  ) {
    this.#signal = AbortSignal.any([context.signal, this.#controller.signal]);
  }

  public dispose(): void {
    this.#controller.abort();
  }

  public check(): void {
    this.#signal.throwIfAborted();
    if (this.#failed) throw this.#failure;
  }

  /** Offer the completed visible prefix independently of overscan and CPU admission. */
  public prioritize(): void {
    this.#priorityEnd = this.paths.length;
    this.offer();
    this.check();
  }

  public offer(): void {
    if (this.#flight !== undefined || this.progress?.publish === undefined) return;
    try {
      this.assertRevision();
      const end = this.#priorityEnd ?? this.paths.length;
      const ready = this.paths
        .slice(this.#published, end)
        .filter(({ id }) => this.progress!.operation.has(id));
      this.#published = end;
      this.#priorityEnd = undefined;
      if (ready.length === 0) return;
      const acknowledgement = this.progress.publish(ready, this.#signal);
      this.#flight = waitScenePathAcknowledgement(acknowledgement, this.#signal).then(
        () => this.acknowledge(),
        (error: unknown) => {
          this.#failed = true;
          this.#failure = error;
          this.#flight = undefined;
        },
      );
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
    }
  }

  private async acknowledge(): Promise<void> {
    try {
      if (this.#priorityEnd !== undefined) {
        const pending = this.context.checkpoint();
        if (pending !== undefined) await waitScenePathAcknowledgement(pending, this.#signal);
      }
      this.check();
      this.#flight = undefined;
      if (this.#priorityEnd !== undefined) this.offer();
    } catch (error) {
      this.#failed = true;
      this.#failure = error;
      this.#flight = undefined;
    }
  }

  public async drain(): Promise<void> {
    for (;;) {
      this.check();
      this.offer();
      if (this.#flight === undefined) {
        this.check();
        return;
      }
      await this.#flight;
      this.check();
      if (this.#published < this.paths.length) {
        const admission = this.context.checkpoint();
        if (admission !== undefined) await admission;
      }
    }
  }
}

function waitScenePathAcknowledgement(
  acknowledgement: Promise<void> | void,
  signal: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = (): void =>
      reject(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Scene path acknowledgement was cancelled."),
      );
    if (signal.aborted) abort();
    else signal.addEventListener("abort", abort, { once: true });
    void Promise.resolve(acknowledgement).then(
      () => {
        signal.removeEventListener("abort", abort);
        resolve();
      },
      (error: unknown) => {
        signal.removeEventListener("abort", abort);
        reject(error instanceof Error ? error : new Error("Scene path acknowledgement failed."));
      },
    );
  });
}

export async function validatePreparedScenePaths(
  request: PrepareScenePathsRuntimeRequest,
  result: PreparedScenePathsRuntimeSuccess,
  options: RuntimeWireSliceOptions,
  context?: ScenePathValidationContext,
): Promise<ValidatedScenePathBatch> {
  options.signal.throwIfAborted();
  context ??= new ScenePathValidationContext(request);
  if (
    result.basisRevision !== context.request.basisRevision ||
    !Array.isArray(result.paths) ||
    result.paths.length > context.request.ids.length
  )
    throw new TypeError("Prepared scene paths do not match the requested model revision.");
  const paths = result.paths as PreparedScenePathsRuntimeSuccess["paths"];
  let bytes = 0;
  let firstIdIndex = -1;
  let previousIndex = -1;
  for (const path of paths) {
    options.signal.throwIfAborted();
    const index = context.position(path.id);
    if (index <= previousIndex || !Array.isArray(path.parts) || path.parts.length !== 1)
      throw new TypeError("Prepared scene paths do not match the requested visible IDs.");
    previousIndex = index;
    if (firstIdIndex === -1) firstIdIndex = index;
    const part = (path.parts as readonly SvgPathPart[])[0];
    if (
      part === null ||
      part === undefined ||
      typeof part !== "object" ||
      (part.paint !== "fill" && part.paint !== "stroke")
    )
      throw new TypeError("Prepared scene path exceeds the internal geometry contract.");
    const d = part.d;
    if (typeof d !== "string")
      throw new TypeError("Prepared scene path exceeds the internal geometry contract.");
    bytes += 128 + path.id.length * 2 + d.length * 2;
    if (
      bytes > (context.request.maxBytes ?? MAX_SCENE_PATH_BYTES) ||
      !/^[MLQAZmlqazhv0-9., e+-]*$/u.test(d)
    )
      throw new TypeError("Prepared scene contour exceeds the internal transport contract.");
    const pending = options.checkpoint();
    if (pending !== undefined) await pending;
    options.signal.throwIfAborted();
  }
  return { bytes, firstIdIndex, lastIdIndex: previousIndex };
}
