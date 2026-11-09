import { bindElementLanguage } from "../../../rendering/localization/element-language";
import type { Localization } from "../../../domain/localization";
import { setMenuSurfaceLabel } from "../menu-dom";
interface PanelLocaleOptions {
  readonly localization?: Localization | undefined;
  readonly kind: string;
  readonly readLabel?: () => string;
}
export function bindPanelLocale(
  surface: HTMLElement,
  options: PanelLocaleOptions,
  updates: (() => void)[],
): () => void {
  const localization = options.localization;
  if (localization === undefined) return () => undefined;
  const releaseLanguage = bindElementLanguage(surface, localization);
  if (options.kind !== "dialog")
    updates.push(() => {
      const key =
        options.kind === "style"
          ? "editor.action.style"
          : options.kind === "background"
            ? "editor.action.background"
            : "editor.ui.menu";
      const label = options.readLabel?.() ?? localization.t(key);
      if (surface.hasAttribute("aria-labelledby")) setMenuSurfaceLabel(surface, label);
      else surface.setAttribute("aria-label", label);
    });
  const unsubscribe = localization.subscribe(() => updates.forEach((update) => update()));
  return () => {
    unsubscribe();
    releaseLanguage();
    updates.length = 0;
  };
}
