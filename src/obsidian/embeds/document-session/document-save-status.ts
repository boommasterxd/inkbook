import type { DocumentSaveStatus } from "../../../editor/session/session-port";
import type { AutosaveCoordinator } from "../../../persistence/saving/autosave/public";

/** Coarse presentation state derived only from the owning autosave coordinator. */
export class DocumentSaveStatusSource {
  #disposed = false;
  readonly #listeners = new Set<() => void>();
  #status: DocumentSaveStatus = "saved";

  public readonly current = (): DocumentSaveStatus => this.#status;

  public readonly subscribe = (listener: () => void): (() => void) => {
    if (this.#disposed) return () => undefined;
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  public update(autosave: Pick<AutosaveCoordinator, "dirty" | "status">): void {
    if (this.#disposed) return;
    const status = documentSaveStatus(autosave);
    if (status === this.#status) return;
    this.#status = status;
    for (const listener of this.#listeners) listener();
  }

  public dispose(): void {
    this.#disposed = true;
    this.#listeners.clear();
  }
}

function documentSaveStatus(
  autosave: Pick<AutosaveCoordinator, "dirty" | "status">,
): DocumentSaveStatus {
  switch (autosave.status) {
    case "conflict":
    case "executor-failed":
    case "retryable-error":
    case "verification-required":
      return "failed";
    case "saving":
      return "saving";
    default:
      return autosave.dirty ? "pending" : "saved";
  }
}
