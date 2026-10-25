import type { ConnectedSelectionPreviewSession } from "../../../../editor/selection/public";
import type { InkElementV1 } from "../../../../domain/schema/public";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";
import type { ElementStore } from "../../../../domain/store/public";
import type { ElementSceneStore } from "../scene-store";

/** Owns cycle preparation and its lifetime for a single linear gesture. */
export class ConnectionPreviewPreparation {
  readonly #abort = new AbortController();
  readonly #unsubscribe: () => void = () => {};
  readonly #prepare: () => void = () => {};
  #dirty = true;
  readonly #scheduler: WorkScheduler | undefined;
  #connected: ConnectedSelectionPreviewSession | undefined;

  public constructor(
    ports: {
      readonly store: ElementStore;
      readonly sceneStore: ElementSceneStore;
      readonly scheduler?: WorkScheduler;
    },
    element: InkElementV1 | undefined,
    onReady: () => void,
  ) {
    const scheduler = ports.scheduler;
    this.#scheduler = scheduler;
    if (
      scheduler === undefined ||
      element === undefined ||
      (element.kind !== "line" && element.kind !== "arrow")
    )
      return;
    this.#unsubscribe = ports.store.subscribe((delta) => {
      if (
        delta.changes.some(
          (change) =>
            change.before === null ||
            change.after === null ||
            change.domains.includes("connection"),
        )
      ) {
        this.#dirty = true;
      }
    });
    this.#prepare = () => {
      void ports.sceneStore.prepareConnections(element.id, scheduler, this.#abort.signal).then(
        (ready) => {
          if (ready && !this.#abort.signal.aborted) onReady();
        },
        () => {
          /* Failed preparation retains fail-closed snapping. */
        },
      );
    };
    this.ensure();
  }

  public prepareConnected(session: ConnectedSelectionPreviewSession, onReady: () => void): void {
    this.#connected = session;
    if (this.#scheduler === undefined) return;
    void session.prepare(this.#scheduler, this.#abort.signal).then(
      (ready) => {
        if (ready && !this.#abort.signal.aborted) onReady();
      },
      () => {
        /* Invalid or cancelled preparation publishes no dependent preview. */
      },
    );
  }

  public ensure(): void {
    if (!this.#dirty || this.#abort.signal.aborted) return;
    this.#dirty = false;
    this.#prepare();
  }

  public retainPreview(): () => void {
    this.#abort.abort();
    this.#unsubscribe();
    return () => this.#connected?.dispose();
  }

  public dispose(): void {
    this.retainPreview()();
  }
}
