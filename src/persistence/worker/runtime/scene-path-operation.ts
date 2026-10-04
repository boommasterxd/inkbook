import type { PurposeOperationIdentity } from "../protocol";
import type { PrepareScenePathsRuntimeRequest, RuntimeSliceContext } from "./types";
import { assertScenePathIds } from "./scene-path-limits";

/** Retargeting only removes IDs from one admitted operation. */
export class ScenePathOperation {
  readonly #retained: Set<string>;
  #current: { readonly id: string; readonly controller: AbortController } | undefined;
  public constructor(public readonly request: PrepareScenePathsRuntimeRequest) {
    assertScenePathIds(request.ids);
    if (request.streamProgress !== undefined && typeof request.streamProgress !== "boolean")
      throw new TypeError("Invalid scene preparation progress mode.");
    this.#retained = new Set(request.ids);
  }

  public matches(identity: PurposeOperationIdentity): boolean {
    const candidate = this.request.identity;
    return (
      candidate.sessionId === identity.sessionId &&
      candidate.workerEpoch === identity.workerEpoch &&
      candidate.operationId === identity.operationId &&
      candidate.purpose === identity.purpose
    );
  }

  public retarget(ids: readonly string[]): void {
    assertScenePathIds(ids);
    const next = new Set(ids);
    for (const id of this.#retained) if (!next.has(id)) this.#retained.delete(id);
    if (this.#current !== undefined && !this.has(this.#current.id))
      this.#current.controller.abort();
  }

  public has(id: string): boolean {
    return this.#retained.has(id);
  }

  public begin(id: string, context: RuntimeSliceContext): RuntimeSliceContext {
    const controller = new AbortController();
    this.#current = { id, controller };
    return { ...context, signal: AbortSignal.any([context.signal, controller.signal]) };
  }

  public finish(): void {
    this.#current = undefined;
  }
}
