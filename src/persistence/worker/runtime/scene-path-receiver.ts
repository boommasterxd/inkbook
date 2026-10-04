import type { BridgeScenePaths } from "./bridge-messages";
import { assertResultMatchesRequest } from "./request-result-validation";
import { MAX_SCENE_PATH_BYTES, scenePathBytes } from "./scene-path-limits";
import { assertScenePathIds } from "./scene-path-limits";
import type { DocumentRuntimeObserver, DocumentRuntimeRequest } from "./types";

/** Backpressure permits one validated progress message at a time per operation. */
export class ScenePathReceiver {
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
    this.retainedIds = ids;
  }
  #pending = false;
  #index = 0;
  #bytes = 0;
  #lastIdIndex = -1;
  public get waiting(): boolean {
    return this.#pending;
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
      await assertResultMatchesRequest(request, message.batch, { checkpoint, signal });
      for (const path of message.batch.paths) {
        const index = request.ids.indexOf(path.id);
        if (index <= this.#lastIdIndex) throw new Error("Scene path progress repeated an ID.");
        this.#lastIdIndex = index;
        this.#bytes += scenePathBytes(path.id, path.parts);
      }
      if (this.#bytes > MAX_SCENE_PATH_BYTES)
        throw new Error("Scene path progress exceeds its byte limit.");
      await observer?.scenePaths?.(message.batch, signal);
      signal.throwIfAborted();
      this.#index++;
    } finally {
      this.#pending = false;
    }
  }
}
