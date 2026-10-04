import type { ScenePathPreparation } from "../../domain/geometry/prepared-scene-paths";
import type { PurposeOperationIdentity } from "../../persistence/worker/protocol";
import type { DocumentRuntimePort } from "../../persistence/worker/runtime/public";

interface SessionScenePathOptions {
  readonly disposed: () => boolean;
  readonly executor: () => DocumentRuntimePort | undefined;
  readonly revision: () => number;
  readonly sessionId: string;
  readonly synchronize: (identity: PurposeOperationIdentity) => Promise<boolean>;
  readonly workerEpoch: () => number;
}

/** One presentation requests only its currently admitted visible contour. */
export class SessionScenePaths {
  #operationId = 0;
  public constructor(private readonly options: SessionScenePathOptions) {}

  public readonly prepare: ScenePathPreparation = async (ids, signal, observer) => {
    if (signal.aborted || this.options.disposed()) return undefined;
    const identity: PurposeOperationIdentity = {
      operationId: ++this.#operationId,
      purpose: "background",
      sessionId: this.options.sessionId,
      workerEpoch: this.options.workerEpoch(),
    };
    const revision = this.options.revision();
    let executor: DocumentRuntimePort | undefined;
    const cancel = (): void => executor?.cancelScenePreparation?.(identity);
    signal.addEventListener("abort", cancel, { once: true });
    try {
      if (
        !(await this.options.synchronize(identity)) ||
        !this.isCurrent(identity, revision, signal)
      )
        return undefined;
      executor = this.options.executor();
      if (executor === undefined) return undefined;
      let retainedIds = ids;
      let started = false;
      observer?.setRetarget((retained) => {
        retainedIds = retained;
        if (started) executor?.retargetScenePreparation?.(identity, retained);
      });
      const requestIds = retainedIds;
      const pending = executor.execute(
        {
          basisRevision: revision,
          identity,
          ids: requestIds,
          streamProgress: observer !== undefined,
          type: "prepare-scene-paths",
        },
        {
          unlockBatch: () => undefined,
          scenePaths: (batch) => {
            if (this.isCurrent(identity, revision, signal) && batch.basisRevision === revision)
              observer?.onProgress(batch.paths);
          },
        },
      );
      started = true;
      if (retainedIds !== requestIds) executor.retargetScenePreparation?.(identity, retainedIds);
      const result = await pending;
      if (
        !this.isCurrent(identity, revision, signal) ||
        result.type !== "prepare-scene-paths-success" ||
        result.basisRevision !== revision ||
        result.identity.operationId !== identity.operationId ||
        result.identity.sessionId !== identity.sessionId ||
        result.identity.workerEpoch !== identity.workerEpoch
      )
        return undefined;
      return result.paths;
    } catch {
      return undefined;
    } finally {
      observer?.setRetarget(undefined);
      signal.removeEventListener("abort", cancel);
    }
  };

  private isCurrent(
    identity: PurposeOperationIdentity,
    revision: number,
    signal: AbortSignal,
  ): boolean {
    return (
      !signal.aborted &&
      !this.options.disposed() &&
      this.options.revision() === revision &&
      this.options.workerEpoch() === identity.workerEpoch
    );
  }
}
