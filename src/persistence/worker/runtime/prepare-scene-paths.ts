import type { IncrementalDocumentSerializer } from "../../serialization/incremental-document-serializer";
import { assertScenePathIds, MAX_SCENE_PATH_BYTES, scenePathBytes } from "./scene-path-limits";
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
    // Complete contours are published only at a shared scheduler handoff.
    publisher.offer();
    return pending.then(() => publisher.check());
  };
  try {
    for (const id of request.ids) {
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
      if (bytes + nextBytes > MAX_SCENE_PATH_BYTES) continue;
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
    this.context.signal.throwIfAborted();
    if (this.#failed) throw this.#failure;
  }

  public offer(): void {
    if (this.#flight !== undefined || this.progress?.publish === undefined) return;
    this.assertRevision();
    const ready = this.paths
      .slice(this.#published)
      .filter(({ id }) => this.progress!.operation.has(id));
    this.#published = this.paths.length;
    if (ready.length === 0) return;
    try {
      const acknowledgement = this.progress.publish(ready, this.#signal);
      this.#flight = waitScenePathAcknowledgement(acknowledgement, this.#signal).then(
        () => {
          this.#flight = undefined;
        },
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
): Promise<void> {
  options.signal.throwIfAborted();
  assertScenePathIds(request.ids);
  if (
    result.basisRevision !== request.basisRevision ||
    !Array.isArray(result.paths) ||
    result.paths.length > request.ids.length
  )
    throw new TypeError("Prepared scene paths do not match the requested model revision.");
  const paths = result.paths as PreparedScenePathsRuntimeSuccess["paths"];
  assertScenePathIds(paths.map(({ id }) => id));
  let bytes = 0;
  let previousIndex = -1;
  for (const path of paths) {
    options.signal.throwIfAborted();
    const index = request.ids.indexOf(path.id);
    if (index <= previousIndex || !Array.isArray(path.parts) || path.parts.length !== 1)
      throw new TypeError("Prepared scene paths do not match the requested visible IDs.");
    previousIndex = index;
    const part = (path.parts as readonly SvgPathPart[])[0];
    if (
      part === null ||
      part === undefined ||
      typeof part !== "object" ||
      typeof part.d !== "string" ||
      (part.paint !== "fill" && part.paint !== "stroke")
    )
      throw new TypeError("Prepared scene path exceeds the internal geometry contract.");
    bytes += scenePathBytes(path.id, path.parts);
    if (bytes > MAX_SCENE_PATH_BYTES || !/^[MLQAZmlqazhv0-9., e+-]*$/u.test(part.d))
      throw new TypeError("Prepared scene contour exceeds the internal transport contract.");
    const pending = options.checkpoint();
    if (pending !== undefined) await pending;
    options.signal.throwIfAborted();
  }
}
