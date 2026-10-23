import type { BridgeScenePaths } from "./bridge-messages";
import type { RuntimeWireSliceOptions } from "../wire/element-wire-codec";
import { assertResultMatchesRequest } from "./request-result-validation";
import {
  MAX_SCENE_PATH_BYTES,
  ScenePathValidationContext,
  assertScenePathIds,
} from "../model/scene-path-limits";
import type {
  DocumentRuntimeObserver,
  DocumentRuntimeRequest,
  DocumentRuntimeResult,
} from "../types";

/** Backpressure permits one validated progress message at a time per operation. */
export class ScenePathReceiver {
  #context: ScenePathValidationContext | undefined;
  public constructor(request?: DocumentRuntimeRequest) {
    if (request?.type === "prepare-scene-paths")
      this.#context = new ScenePathValidationContext(request);
  }
  public get request(): DocumentRuntimeRequest | undefined {
    return this.#context?.request;
  }
  public static needsObserver(
    request: DocumentRuntimeRequest,
    observer: DocumentRuntimeObserver | undefined,
  ): boolean {
    return (
      request.type === "prepare-scene-paths" &&
      request.streamProgress === true &&
      observer?.scenePaths === undefined
    );
  }
  public retainedIds: readonly string[] | undefined;
  public retarget(ids: readonly string[]): void {
    assertScenePathIds(ids);
    this.retainedIds = Object.freeze([...ids]);
  }
  #pending = false;
  #index = 0;
  #bytes = 0;
  #lastIdIndex = -1;
  public get waiting(): boolean {
    return this.#pending;
  }
  public async validateResult(
    request: DocumentRuntimeRequest,
    result: DocumentRuntimeResult,
    options: RuntimeWireSliceOptions,
  ): Promise<void> {
    if (request.type === "prepare-scene-paths")
      this.#context ??= new ScenePathValidationContext(request);
    const validated = await assertResultMatchesRequest(
      this.#context?.request ?? request,
      result,
      options,
      this.#context,
    );
    if (validated === undefined) return;
    if (validated.firstIdIndex !== -1 && validated.firstIdIndex <= this.#lastIdIndex)
      throw new Error("Scene path progress repeated an ID.");
    if (validated.lastIdIndex !== -1) this.#lastIdIndex = validated.lastIdIndex;
    this.#bytes += validated.bytes;
    if (this.#bytes > (this.#context?.request.maxBytes ?? MAX_SCENE_PATH_BYTES))
      throw new Error("Scene path progress exceeds its byte limit.");
  }
  public async adopt(
    message: BridgeScenePaths,
    request: DocumentRuntimeRequest,
    observer: DocumentRuntimeObserver | undefined,
    signal: AbortSignal,
    checkpoint: () => Promise<void> | undefined,
  ): Promise<void> {
    if (
      request.type !== "prepare-scene-paths" ||
      request.streamProgress !== true ||
      this.#pending ||
      message.batchIndex !== this.#index
    )
      throw new Error("Scene path progress violates the operation ordering contract.");
    this.#pending = true;
    try {
      const admission = checkpoint();
      if (admission !== undefined) await admission;
      if (message.batch.type !== "prepare-scene-paths-success")
        throw new Error("Scene path progress requires contours.");
      await this.validateResult(request, message.batch, { checkpoint, signal });
      await observer?.scenePaths?.(message.batch, signal);
      signal.throwIfAborted();
      this.#index++;
    } finally {
      this.#pending = false;
    }
  }
}
