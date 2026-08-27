import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { ElementStore } from "../../../domain/store/public";
import type { EditorTool } from "../../../editor/input/index";
import type { StyleControl, ToolbarStyleIconState } from "../../../rendering/ui/index";
import type { ActiveShapeIconState } from "../../../rendering/ui/icon-ids";

import { selectedElements } from "./controller-elements";
import {
  createActiveEditorStyleControls,
  createActiveEditorStyleIcon,
  createActiveShapeIcon,
  createSelectionStyleReplacement,
  updateSessionToolDefaults,
} from "./controller-styles";
import type { ActiveEditorHistory } from "./history";
import type { ElementSceneStore } from "./scene-store";

export interface ActiveEditorStyleSessionOptions {
  readonly defaults: ToolDefaultsV1;
  readonly history: ActiveEditorHistory;
  readonly onStateChanged: () => void;
  readonly sceneStore: ElementSceneStore;
  readonly selection: () => ReadonlySet<string>;
  readonly store: ElementStore;
}

export class ActiveEditorStyleSession {
  #defaults: ToolDefaultsV1;
  readonly #history: ActiveEditorHistory;
  readonly #onStateChanged: () => void;
  readonly #sceneStore: ElementSceneStore;
  readonly #selection: () => ReadonlySet<string>;
  readonly #store: ElementStore;

  public constructor(options: ActiveEditorStyleSessionOptions) {
    this.#defaults = structuredClone(options.defaults);
    this.#history = options.history;
    this.#onStateChanged = options.onStateChanged;
    this.#sceneStore = options.sceneStore;
    this.#selection = options.selection;
    this.#store = options.store;
  }

  public get defaults(): ToolDefaultsV1 {
    return this.#defaults;
  }

  public presentation(tool: EditorTool): {
    readonly controls: readonly StyleControl[];
    readonly icon: ToolbarStyleIconState;
    readonly shapeIcon: ActiveShapeIconState;
  } {
    return {
      controls: createActiveEditorStyleControls({
        defaults: this.#defaults,
        selection: selectedElements(this.#sceneStore, this.#selection()),
        tool,
      }),
      icon: createActiveEditorStyleIcon(this.#defaults, tool),
      shapeIcon: createActiveShapeIcon(this.#defaults),
    };
  }

  public apply(tool: EditorTool, id: string, value: boolean | number | string): void {
    const elements = selectedElements(this.#sceneStore, this.#selection());
    if (elements.length > 0) {
      const replacement = createSelectionStyleReplacement(elements, id, value);
      if (replacement !== null) {
        const complete = completeReplacement(replacement.replacements, this.#store);
        if (complete !== null) this.#history.replace(complete.previous, complete.replacements);
      }
      return;
    }
    const defaults = updateSessionToolDefaults(this.#defaults, tool, id, value);
    if (defaults === this.#defaults) return;
    this.#defaults = defaults;
    this.#onStateChanged();
  }
}

function completeReplacement(
  requested: readonly InkElementV1[],
  store: ElementStore,
): {
  readonly previous: readonly InkElementV1[];
  readonly replacements: readonly InkElementV1[];
} | null {
  const plan = store.planReplacements(requested);
  if (plan === null) return null;
  const previous = plan.elements.map(({ id }) => {
    const record = store.get(id);
    if (record === undefined) throw new Error(`Missing style replacement source: ${id}`);
    return record.element as InkElementV1;
  });
  return { previous, replacements: plan.elements };
}
