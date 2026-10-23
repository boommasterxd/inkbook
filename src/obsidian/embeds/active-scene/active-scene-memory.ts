import type { EditableDocumentModel } from "../document-session/document-model-port";
import { ActiveDocumentMemoryCoordinator } from "../../../editor/session/active-document-memory-coordinator";
import type { SvgSceneRenderer } from "../../../rendering/scene";
import { ElementSceneStore } from "../active-editor/scene-store";

export class ActiveSceneMemoryBinding {
  #coordinator: ActiveDocumentMemoryCoordinator | undefined;
  public readonly store: ElementSceneStore;

  public constructor(model: Pick<EditableDocumentModel, "store" | "prepareScenePaths">) {
    this.store = new ElementSceneStore(model.store, this.evaluate);
    this.store.prepareScenePaths = model.prepareScenePaths;
  }

  public readonly evaluate = (): void => {
    this.#coordinator?.evaluate();
  };

  public attach(scene: SvgSceneRenderer): void {
    if (this.#coordinator !== undefined) {
      throw new Error("The active-scene memory binding is already attached.");
    }
    this.#coordinator = new ActiveDocumentMemoryCoordinator({ scene, store: this.store });
    this.evaluate();
  }

  public release(): void {
    this.#coordinator?.release();
    this.#coordinator = undefined;
    this.store.release();
  }
}
