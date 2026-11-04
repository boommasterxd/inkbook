import type { ToolDefaultsV1 } from "../../../domain/settings/types";
import type { ShapeId } from "../../../rendering/ui/toolbar-types";
import { createDragElement } from "../../../editor/tools/public";
import { AdaptivePanelSession } from "../../menus/panels/adaptive-panel";
import type { PhoneSheetNavigation } from "../../menus/panels/panel-page";
import { createGeometryMenuContent } from "../../menus/geometry-menu-content";
import {
  KeyboardHandleInteraction,
  keyboardHandleName,
  type KeyboardHandleOptions,
} from "./previews/keyboard-handle-interaction";
import type { ActiveEditorNavigation } from "./navigation/navigation";

interface GeometrySessionOptions extends Omit<KeyboardHandleOptions, "settled"> {
  readonly enabled: () => boolean;
  readonly navigation: ActiveEditorNavigation;
  readonly setSelection: (selection: ReadonlySet<string>) => void;
}

/** Owns one discrete edit planner shared by keyboard input and an adaptive geometry panel. */
export class ActiveEditorGeometrySession {
  public readonly interaction: KeyboardHandleInteraction;
  readonly #options: GeometrySessionOptions;
  #panel: AdaptivePanelSession | undefined;
  #navigation: PhoneSheetNavigation | undefined;
  #releaseContent: (() => void) | undefined;

  public constructor(options: GeometrySessionOptions) {
    this.#options = options;
    this.interaction = new KeyboardHandleInteraction({ ...options, settled: () => undefined });
  }

  public get isOpen(): boolean {
    return this.#panel !== undefined || this.#navigation !== undefined;
  }

  public insert(shape: ShapeId, defaults: ToolDefaultsV1): void {
    if (!this.#options.enabled()) return;
    const { controller, navigation } = this.#options;
    const center = navigation.visibleCenter();
    const width = controller.model.page.innerWidth + 2 * controller.model.page.margin;
    const linear = shape === "line" || shape === "arrow";
    const start = {
      x: Math.max(0, Math.min(width - 100, center.x - 50)),
      y: Math.max(0, center.y - (linear ? 0 : 50)),
    };
    try {
      const element = createDragElement({
        defaults,
        identity: {
          id: controller.container.ownerDocument.defaultView!.crypto.randomUUID(),
          createdAt: Date.now(),
        },
        start,
        end: { x: start.x + 100, y: start.y + (linear ? 0 : 100) },
        tool: shape,
      });
      if (!controller.history.create([element])) return;
      this.#options.setSelection(new Set([element.id]));
      const record = controller.model.store.get(element.id);
      if (record !== undefined) navigation.revealBounds(record.bounds);
      this.open();
    } catch {
      controller.onFeedback("history-change-failed");
    }
  }

  public open(navigation?: PhoneSheetNavigation, returnFocus?: HTMLElement): void {
    if (!this.#options.enabled() || this.#options.selection().size === 0) return;
    this.close();
    if (navigation !== undefined) {
      this.#navigation = navigation;
      navigation.push({
        kind: "dialog",
        label: "Edit geometry",
        createContent: () => this.#createContent(),
        dispose: () => this.#disposeContent(),
      });
      return;
    }
    const { controller } = this.#options;
    const surface = controller.renderer.inputSurface;
    const ownerDocument = surface.ownerDocument;
    const anchor =
      returnFocus ??
      surface
        .closest(".inkbook-embed-root")
        ?.querySelector<HTMLElement>('[data-inkbook-action="overflow"]') ??
      surface;
    this.#panel = new AdaptivePanelSession({
      anchor,
      canvasInputSurface: surface,
      createContent: () => this.#createContent(),
      kind: "dialog",
      label: "Edit geometry",
      onClosed: () => {
        this.#panel = undefined;
        this.#disposeContent();
      },
      onClosing: () => this.interaction.cancel(),
      ownerDocument,
      ownerWindow: ownerDocument.defaultView!,
      renderIcon: controller.renderIcon,
      workScheduler: controller.workScheduler,
      ...(controller.keymap === undefined ? {} : { keymap: controller.keymap }),
      ...(controller.createPhoneSheetHost === undefined
        ? {}
        : { createPhoneSheetHost: controller.createPhoneSheetHost }),
    });
  }

  public close(): void {
    this.#panel?.close("immediate");
    this.#panel = undefined;
    const navigation = this.#navigation;
    this.#navigation = undefined;
    navigation?.back();
    this.#disposeContent();
  }

  #createContent(): DocumentFragment {
    const selection = this.#options.selection();
    const content = createGeometryMenuContent({
      ownerDocument: this.#options.controller.container.ownerDocument,
      operations: [undefined, ...this.interaction.choices()].map((handle, index) => ({
        value: index - 1,
        label: keyboardHandleName(handle),
      })),
      onOperation: (index) => this.interaction.focus(index),
      onStep: (index, delta) => {
        if (
          !this.#options.enabled() ||
          this.interaction.pending ||
          this.#options.selection() !== selection
        )
          return;
        this.interaction.focus(index);
        this.interaction.step(index, delta);
        if (this.interaction.pending) content.status.textContent = "Preparing geometry change…";
      },
      renderIcon: this.#options.controller.renderIcon,
    });
    const release = this.interaction.subscribeSettled((committed) => {
      content.status.replaceChildren(
        content.status.ownerDocument.createTextNode(
          committed ? "Geometry updated." : "The geometry change could not be applied.",
        ),
      );
    });
    const unsubscribe = this.#options.controller.model.store.subscribe((delta) => {
      if (
        this.#options.selection() !== selection ||
        delta.changes.some((change) => change.after === null && selection.has(change.id))
      )
        this.close();
    });
    this.#releaseContent = () => {
      release();
      unsubscribe();
    };
    this.interaction.focus(-1);
    return content.fragment;
  }

  #disposeContent(): void {
    this.#releaseContent?.();
    this.#releaseContent = undefined;
    this.#navigation = undefined;
    this.interaction.cancel();
  }
}
