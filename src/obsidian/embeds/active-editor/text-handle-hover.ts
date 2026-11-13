import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { ActiveEditorHandleInteraction } from "./previews/handle-interaction";
import type { ActiveEditorNavigation } from "./navigation/navigation";
import { TextHandleProjection } from "./text-handle-projection";
import type { TextEditingCoordinates } from "../../../rendering/scene/text-editing-geometry";

/** Routes source-editor hover through the retained selection handle cursor geometry. */
export class TextHandleHover {
  #projection: TextHandleProjection | undefined;
  #cursor: string | undefined;
  #document: Document;
  #documents: readonly Document[];
  public constructor(
    private readonly options: {
      readonly document: Document;
      readonly ownerWindow: Window;
      readonly scheduler: WorkScheduler;
      readonly active: () => boolean;
      readonly coordinates?: () => TextEditingCoordinates | undefined;
      readonly handles: Pick<ActiveEditorHandleInteraction, "cursorAt">;
      readonly navigation: Pick<ActiveEditorNavigation, "pageSample" | "screenPointer">;
    },
  ) {
    this.#document = options.document;
    this.#documents = [options.document];
    this.listen(true);
  }

  public setDocument(document: Document): void {
    const drawing = this.options.coordinates?.()?.drawingDocument;
    const documents = drawing && drawing !== document ? [document, drawing] : [document];
    if (
      document === this.#document &&
      documents.every((item, index) => this.#documents[index] === item) &&
      documents.length === this.#documents.length
    ) {
      this.clear();
      return;
    }
    this.clear();
    this.listen(false);
    this.#document = document;
    this.#documents = documents;
    this.listen(true);
  }

  private listen(add: boolean): void {
    const method = add ? "addEventListener" : "removeEventListener";
    for (const document of this.#documents) {
      document[method]("pointermove", this.#move as EventListener, true);
      document[method]("pointerout", this.#out as EventListener, true);
      document.defaultView?.[method]("blur", this.clear);
    }
  }

  public readonly clear = (): void => {
    this.#projection?.dispose();
    this.#projection = undefined;
    this.#write(undefined);
  };

  public dispose(): void {
    this.clear();
    this.listen(false);
  }

  readonly #move = (event: PointerEvent): void => {
    if (!this.options.active() || event.pointerType === "touch") {
      this.clear();
      return;
    }
    const source = (event.target as Node | null)?.ownerDocument;
    if (this.#projection && this.#projection.document !== source) this.clear();
    const projection = (this.#projection ??= new TextHandleProjection(
      event,
      this.options.ownerWindow,
      this.options.scheduler,
      this.options.coordinates?.(),
    ));
    const pointer = this.options.navigation.pageSample(
      this.options.navigation.screenPointer(projection.event(event)),
    );
    const content = Boolean(
      (event.target as Element | null)?.closest?.(".cm-content,.inkbook-text-table-controls-layer"),
    );
    this.#write(this.options.handles.cursorAt(pointer, content));
  };

  readonly #out = (event: PointerEvent): void => {
    if (event.relatedTarget === null) this.clear();
  };

  #write(cursor: string | undefined): void {
    if (this.#cursor === cursor) return;
    this.#cursor = cursor;
    for (const document of this.#documents) {
      const root = document.documentElement;
      if (cursor === undefined) {
        root.removeAttribute("data-inkbook-text-handle-cursor");
        root.style.removeProperty("--inkbook-text-handle-cursor");
      } else {
        root.setAttribute("data-inkbook-text-handle-cursor", "");
        root.style.setProperty("--inkbook-text-handle-cursor", cursor);
      }
    }
  }
}
