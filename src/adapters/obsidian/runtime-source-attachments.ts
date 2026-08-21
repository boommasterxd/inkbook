import type { ViewId } from "../../application/note-session";
import type { RuntimePersistenceSourceV1 } from "./runtime-persistence-source";

const MAX_RUNTIME_ATTACHED_VIEWS = Number("32");

export class RuntimeViewAttachmentsV1 {
  readonly #views = new Set<ViewId>();
  #source: RuntimePersistenceSourceV1 | null = null;

  public attach(viewId: ViewId): boolean {
    if (this.#views.has(viewId)) return true;
    if (this.#views.size >= MAX_RUNTIME_ATTACHED_VIEWS) return false;
    this.#views.add(viewId);
    this.#source?.attach(viewId);
    return true;
  }

  public detach(viewId: ViewId): void {
    if (!this.#views.delete(viewId)) return;
    this.#source?.detach(viewId);
  }

  public bind(source: RuntimePersistenceSourceV1): void {
    if (this.#source !== null) return;
    this.#source = source;
    for (const viewId of this.#views) source.attach(viewId);
  }

  public has(viewId: ViewId): boolean {
    return this.#views.has(viewId);
  }

  public dispose(): void {
    this.#source = null;
    this.#views.clear();
  }
}
