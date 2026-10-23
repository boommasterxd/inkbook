import type { DocumentRuntimePort } from "../../../persistence/worker/runtime/public";
import type { DocumentRuntimeFactories } from "./document-model-port";
import type { SessionIdentity } from "../../../editor/session/session-port";
import type { InteractiveWorkPriority } from "../../../editor/session/interactive-work-priority";

interface VaultExecutorReplacementOptions {
  readonly adopt: (executor: DocumentRuntimePort, workerEpoch: number) => void;
  readonly disposed: () => boolean;
  readonly identity: SessionIdentity;
  readonly fallback: (epoch: number) => DocumentRuntimePort;
  readonly fallbackUsed: () => boolean;
  readonly priority: Pick<InteractiveWorkPriority, "gestureActive" | "navigationActive">;
  readonly runtimes: DocumentRuntimeFactories;
}

/** One native restart per session, followed by at most one bounded fallback. */
export function createVaultExecutorReplacement(
  options: VaultExecutorReplacementOptions,
): (epoch: number, cancelled?: () => boolean) => Promise<DocumentRuntimePort> {
  let restarted = false;
  return async (epoch, cancelled = () => false) => {
    assertLive(options, cancelled);
    if (!restarted && !options.fallbackUsed()) {
      restarted = true;
      let candidate: DocumentRuntimePort | undefined;
      try {
        candidate = await options.runtimes.create(
          options.identity.sessionId,
          epoch,
          options.identity.documentId,
        );
        assertLive(options, cancelled);
        candidate.setLiveInputActive?.(options.priority.gestureActive);
        candidate.setNavigationActive?.(options.priority.navigationActive);
        assertLive(options, cancelled);
        options.adopt(candidate, epoch);
        return candidate;
      } catch {
        candidate?.terminate();
        assertLive(options, cancelled);
      }
    }
    assertLive(options, cancelled);
    if (options.fallbackUsed()) throw new Error("The document fallback executor already failed.");
    return options.fallback(epoch);
  };
}

function assertLive(options: VaultExecutorReplacementOptions, cancelled: () => boolean): void {
  if (options.disposed()) throw new Error("The document session has been disposed.");
  if (cancelled()) throw new Error("The document operation has been cancelled.");
}
