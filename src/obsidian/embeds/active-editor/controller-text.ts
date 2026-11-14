import type { PointV1 } from "../../../domain/schema/public";
import type { TextDefaultsV2 } from "../../../domain/settings/types";
import type { PasteInvocation } from "../../../persistence/clipboard/public";
import { serializeFontStylesheet } from "../../../persistence/serialization/output/text-fonts";
import type { ActiveEditorControllerOptions } from "./controller-types";
import type { ActiveEditorNavigation } from "./navigation/navigation";
import { ActiveTextSession, type ActiveTextSessionOptions } from "./text-session";
import { createTextTableUi } from "./text-table-menu";

export function textPastePoint(invocation: PasteInvocation): PointV1 {
  if (invocation.kind === "context-menu") return invocation.invocationPoint;
  return invocation.kind === "shortcut"
    ? (invocation.lastSessionPointer ?? invocation.visibleCanvasCenter)
    : invocation.visibleCanvasCenter;
}

/** Canvas entry events belong to the owning presentation, not the decorative document. */
export function createControllerTextSession(
  options: ActiveEditorControllerOptions,
  bindings: {
    readonly defaults: () => TextDefaultsV2;
    readonly navigation: ActiveEditorNavigation;
    readonly selection: () => ReadonlySet<string>;
    readonly setSelection: (selection: ReadonlySet<string>) => void;
    readonly isEnabled: () => boolean;
    readonly onStateChanged: () => void;
    readonly onFinished: () => void;
    readonly onHeightChanged?: ActiveTextSessionOptions["onHeightChanged"];
    readonly onPointerDown?: (event: PointerEvent) => boolean;
    readonly onEscape?: () => boolean;
    readonly occlusionTop?: () => number | undefined;
  },
): { readonly session: ActiveTextSession; readonly releaseInput: () => void } {
  const ownerWindow = options.container.ownerDocument.defaultView;
  if (ownerWindow === null) throw new Error("Text input requires an owning window.");
  const session = new ActiveTextSession({
    model: options.model,
    history: options.history,
    renderer: options.renderer,
    ownerWindow,
    scheduler: options.workScheduler,
    defaults: bindings.defaults,
    tableUi: createTextTableUi({
      factory: options.menuFactory,
      owner: options.container,
      localization: options.localization,
    }),
    tableCellLabel:
      options.localization?.t("editor.action.edit-table-cell") ?? "Edit empty table cell",
    ...(options.textFonts === undefined ? {} : { library: options.textFonts }),
    onSelection: bindings.setSelection,
    onStateChanged: bindings.onStateChanged,
    ...(bindings.onHeightChanged ? { onHeightChanged: bindings.onHeightChanged } : {}),
    onError: () => options.onFeedback("text-preparation-failed"),
    onFinished: bindings.onFinished,
    onScrollInterrupt: () => bindings.navigation.cancelPanMomentum(),
    onRevealBounds: (bounds) =>
      bindings.navigation.revealBounds(
        bounds,
        bindings.occlusionTop?.(),
        (bottom) => session.reserveSourceBottom(bottom),
        true,
      ),
    sourceExtentLayout: options.selectionMoveLayout,
    ...(bindings.onPointerDown === undefined ? {} : { onPointerDown: bindings.onPointerDown }),
    ...(options.reconcileTextLayout ? { reconcileHostLayout: options.reconcileTextLayout } : {}),
    onKeyDown: (event) => sourceKeyDown(event),
  });
  if (options.model.fontResources?.length) {
    options.renderer.setTextFonts(serializeFontStylesheet(options.model.fontResources));
  }
  const surface = options.renderer.inputSurface;
  const sourceKeyDown = (event: KeyboardEvent) => {
    if (
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing ||
      !session.inputElement?.contains(event.target as Node | null) ||
      !bindings.onEscape?.()
    )
      return;
    event.preventDefault();
    event.stopImmediatePropagation();
    session.focusInput();
  };
  const keyDown = (event: KeyboardEvent) => {
    if (
      event.key !== "Enter" ||
      event.shiftKey ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey ||
      event.isComposing ||
      event.repeat ||
      !bindings.isEnabled()
    )
      return;
    const selection = bindings.selection();
    if (selection.size !== 1) return;
    const id = selection.values().next().value;
    if (id === undefined || options.model.store.get(id)?.element.kind !== "text") return;
    event.preventDefault();
    event.stopImmediatePropagation();
    void session.edit(id);
  };
  surface.addEventListener("keydown", keyDown, true);
  options.renderer.textDocument.addEventListener("keydown", sourceKeyDown, true);
  return {
    session,
    releaseInput: () => {
      surface.removeEventListener("keydown", keyDown, true);
      options.renderer.textDocument.removeEventListener("keydown", sourceKeyDown, true);
    },
  };
}
