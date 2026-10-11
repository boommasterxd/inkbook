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
import type { PreparedElementHistory } from "./prepared-element-history";
import type { TransformSliceScheduler } from "../../../editor/selection/transforms";

export interface ActiveEditorStyleSessionOptions {
  readonly defaults: ToolDefaultsV1;
  readonly history: ActiveEditorHistory;
  readonly onSelectionGeometryChanged: () => void;
  readonly onStateChanged: () => void;
  readonly sceneStore: ElementSceneStore;
  readonly selection: () => ReadonlySet<string>;
  /** Supply only when membership changes replace the owner's selection identity. */
  readonly selectionIdentity?: () => object;
  readonly selectionFrames?: SelectionFrameSession;
  readonly store: ElementStore;
  readonly preparedHistory?: PreparedElementHistory;
  readonly isEnabled?: () => boolean;
}

export class ActiveEditorStyleSession {
  #defaults: ToolDefaultsV1;
  readonly #history: ActiveEditorHistory;
  readonly #onSelectionGeometryChanged: () => void;
  readonly #onStateChanged: () => void;
  readonly #sceneStore: ElementSceneStore;
  readonly #selection: () => ReadonlySet<string>;
  readonly #selectionIdentity: (() => object) | undefined;
  readonly #unsubscribeStore: (() => void) | undefined;
  #selectedControls:
    { readonly identity: object; readonly controls: readonly StyleControl[] } | undefined;
  #disposed = false;
  readonly #selectionFrames: SelectionFrameSession | undefined;
  readonly #store: ElementStore;
  readonly #preparedHistory: PreparedElementHistory | undefined;
  readonly #isEnabled: () => boolean;

  public constructor(options: ActiveEditorStyleSessionOptions) {
    this.#defaults = structuredClone(options.defaults);
    this.#history = options.history;
    this.#onSelectionGeometryChanged = options.onSelectionGeometryChanged;
    this.#onStateChanged = options.onStateChanged;
    this.#sceneStore = options.sceneStore;
    this.#selection = options.selection;
    this.#selectionIdentity = options.selectionIdentity;
    this.#selectionFrames = options.selectionFrames;
    this.#store = options.store;
    this.#preparedHistory = options.preparedHistory;
    this.#isEnabled = options.isEnabled ?? (() => true);
    this.#unsubscribeStore =
      options.selectionIdentity === undefined
        ? undefined
        : this.#store.subscribe(() => this.invalidateSelection());
  }

  public dispose(): void {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#unsubscribeStore?.();
    this.invalidateSelection();
  }

  public invalidateSelection(): void {
    this.#selectedControls = undefined;
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
    const resolveControls = () => this.#controls(tool);
    let controls: readonly StyleControl[] | undefined;
    return {
      get controls() {
        return (controls ??= resolveControls());
      },
      icon: createActiveEditorStyleIcon(this.#defaults, tool),
      selectionArea: this.#defaults.select.area,
      shapeIcon: createActiveShapeIcon(this.#defaults),
    };
  }

  #controls(tool: EditorTool): readonly StyleControl[] {
    const selection = this.#selection();
    const identity = this.#disposed ? undefined : this.#selectionIdentity?.();
    if (
      selection.size > 0 &&
      identity !== undefined &&
      this.#selectedControls?.identity === identity
    )
      return this.#selectedControls.controls;
    this.invalidateSelection();
    const elements = selectedElements(this.#sceneStore, selection);
    const controls = createActiveEditorStyleControls({
      defaults: this.#defaults,
      selection: elements,
      tool,
    });
    if (identity !== undefined && elements.length > 0)
      this.#selectedControls = { identity, controls };
    return controls;
  }

  public apply(tool: EditorTool, id: string, value: boolean | number | string): void {
    if (this.#disposed || !this.#isEnabled()) return;
    const selection = this.#selection();
    if (selection.size > 0 && this.#preparedHistory !== undefined) {
      if (tool === "select" && (id === "selection-area" || id === "selection-inclusion")) return;
      this.#preparedHistory.commitStyle({
        selection,
        controlId: id,
        value,
        isCurrent: () => this.#selection() === selection,
        frameEffect: (previous, replacements, scheduler) =>
          this.#prepareFrameEffect(previous, replacements, scheduler, id),
        onCompleted: (committed) => {
          if (committed) this.#onSelectionGeometryChanged();
        },
      });
      return;
    }
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

  async #prepareFrameEffect(
    previous: readonly InkElementV1[],
    replacements: readonly InkElementV1[],
    scheduler: TransformSliceScheduler,
    controlId: string,
  ) {
    if (this.#selectionFrames === undefined) return undefined;
    if (
      [
        "color",
        "opacity",
        "outline-color",
        "outline-style",
        "outline-opacity",
        "fill-color",
        "fill-opacity",
      ].includes(controlId)
    )
      return undefined;
    const geometry: SelectedElementGeometry[] = [];
    for (const element of previous) {
      if (scheduler.isCancelled?.()) return undefined;
      if (scheduler.shouldYield()) {
        await scheduler.yieldControl();
        if (scheduler.isCancelled?.()) return undefined;
      }
      const bounds = this.#store.get(element.id)?.bounds;
      if (bounds !== undefined) geometry.push({ bounds, element });
    }
    const frame = await this.#selectionFrames.currentTimeSliced(geometry, scheduler);
    return this.#selectionFrames.rebaseTimeSliced(frame, replacements, scheduler);
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
