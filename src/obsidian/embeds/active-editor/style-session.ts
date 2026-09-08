import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import type { InkElementV1 } from "../../../domain/schema/public";
import type { ElementStore } from "../../../domain/store/public";
import type { EditorTool } from "../../../editor/input/index";
import type { ToolbarStyleIconState } from "../../../rendering/ui/index";
import type { ActiveShapeIconState } from "../../../rendering/ui/icon-ids";
import type { StyleControl } from "../../menus/editor-menu-types";
import type {
  SelectedElementGeometry,
  SelectionFrameSession,
} from "../../../editor/selection/public";

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
  readonly onSelectionGeometryChanged: () => void;
  readonly onStateChanged: () => void;
  readonly sceneStore: ElementSceneStore;
  readonly selection: () => ReadonlySet<string>;
  readonly selectionFrames?: SelectionFrameSession;
  readonly store: ElementStore;
}

export class ActiveEditorStyleSession {
  #defaults: ToolDefaultsV1;
  readonly #history: ActiveEditorHistory;
  readonly #onSelectionGeometryChanged: () => void;
  readonly #onStateChanged: () => void;
  readonly #sceneStore: ElementSceneStore;
  readonly #selection: () => ReadonlySet<string>;
  readonly #selectionFrames: SelectionFrameSession | undefined;
  readonly #store: ElementStore;

  public constructor(options: ActiveEditorStyleSessionOptions) {
    this.#defaults = structuredClone(options.defaults);
    this.#history = options.history;
    this.#onSelectionGeometryChanged = options.onSelectionGeometryChanged;
    this.#onStateChanged = options.onStateChanged;
    this.#sceneStore = options.sceneStore;
    this.#selection = options.selection;
    this.#selectionFrames = options.selectionFrames;
    this.#store = options.store;
  }

  public get defaults(): ToolDefaultsV1 {
    return this.#defaults;
  }

  public presentation(tool: EditorTool): {
    readonly controls: readonly StyleControl[];
    readonly icon: ToolbarStyleIconState;
    readonly selectionArea: ToolDefaultsV1["select"]["area"];
    readonly shapeIcon: ActiveShapeIconState;
  } {
    return {
      controls: createActiveEditorStyleControls({
        defaults: this.#defaults,
        selection: selectedElements(this.#sceneStore, this.#selection()),
        tool,
      }),
      icon: createActiveEditorStyleIcon(this.#defaults, tool),
      selectionArea: this.#defaults.select.area,
      shapeIcon: createActiveShapeIcon(this.#defaults),
    };
  }

  public apply(tool: EditorTool, id: string, value: boolean | number | string): void {
    const elements = selectedElements(this.#sceneStore, this.#selection());
    if (elements.length > 0) {
      if (tool === "select" && (id === "selection-area" || id === "selection-inclusion")) return;
      const replacement = createSelectionStyleReplacement(elements, id, value);
      if (replacement !== null) {
        const complete = completeReplacement(replacement.replacements, this.#store);
        const frame =
          this.#selectionFrames?.current(selectedGeometry(elements, this.#store)) ?? null;
        const effect = this.#selectionFrames?.rebase(frame, replacement.replacements);
        if (
          complete !== null &&
          this.#history.replace(complete.previous, complete.replacements, effect)
        )
          this.#onSelectionGeometryChanged();
      }
      return;
    }
    const defaults = updateSessionToolDefaults(this.#defaults, tool, id, value);
    if (defaults === this.#defaults) return;
    this.#defaults = defaults;
    this.#onStateChanged();
  }
}

function selectedGeometry(
  elements: readonly InkElementV1[],
  store: ElementStore,
): SelectedElementGeometry[] {
  const geometry: SelectedElementGeometry[] = [];
  for (const element of elements) {
    const bounds = store.get(element.id)?.bounds;
    if (bounds !== undefined) geometry.push({ bounds, element });
  }
  return geometry;
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
