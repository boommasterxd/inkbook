import type { ElementStore } from "../../../domain/store/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { TextElementV2 } from "../../../domain/schema/public";
import { elementContainsPoint } from "../../../editor/selection/public";
import type { ActiveEditorNavigation } from "./navigation/navigation";
import { TextHandleProjection } from "./text-handle-projection";
import type { TextEditingCoordinates } from "../../../rendering/scene/text-editing-geometry";

/** Owns only the initiating canvas tap until the native source becomes ready. */
export class TextEntryHandoff {
  #pending: { readonly id: string } | undefined;
  #disposed = false;

  public constructor(
    private readonly options: {
      readonly store: Pick<ElementStore, "get">;
      readonly navigation: Pick<ActiveEditorNavigation, "screenPointer" | "pageSample">;
      readonly ownerWindow: Window;
      readonly scheduler: WorkScheduler;
      readonly edit: (id: string, position: number) => Promise<boolean>;
      readonly coordinates?: () => TextEditingCoordinates | undefined;
    },
  ) {}

  public get pending(): boolean {
    return this.#pending !== undefined;
  }

  public activate(id: string, position: number): void {
    if (this.#disposed || this.#pending) return;
    const pending = { id };
    this.#pending = pending;
    const release = () => {
      if (this.#pending === pending) this.#pending = undefined;
    };
    void this.options.edit(id, position).then(release, release);
  }

  public claim(event: PointerEvent): boolean {
    const pending = this.#pending;
    if (!pending || !primaryEntryContact(event)) return false;
    const element = this.options.store.get(pending.id)?.element;
    if (element?.kind !== "text") return false;
    const projection = new TextHandleProjection(
      event,
      this.options.ownerWindow,
      this.options.scheduler,
      this.options.coordinates?.(),
    );
    try {
      const point = this.options.navigation.pageSample(
        this.options.navigation.screenPointer(projection.event(event)),
      );
      return elementContainsPoint(element as TextElementV2, point, 0);
    } finally {
      projection.dispose();
    }
  }

  public dispose(): void {
    this.#disposed = true;
    this.#pending = undefined;
  }
}

function primaryEntryContact(event: PointerEvent): boolean {
  return (
    event.isPrimary &&
    event.button === 0 &&
    event.buttons === 1 &&
    !(event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) &&
    (event.pointerType !== "pen" || event.pressure > 0)
  );
}
