import { createEnglishLocalization, type Localization } from "../../../domain/localization";
/** Semantic back control shared by nested adaptive panel pages. */
export function createAdaptivePanelHeader(
  scroll: HTMLElement,
  onBack: () => void,
  renderIcon: (element: HTMLElement, icon: string) => void,
  localization?: Localization,
  registerLocaleUpdate?: (update: () => void) => void,
): void {
  const header = scroll.createDiv({ cls: "inkbook-adaptive-panel-header" });
  const back = header.createDiv({ cls: "inkbook-adaptive-panel-back" });
  back.tabIndex = 0;
  back.setAttribute("role", "button");

  const icon = back.createSpan({ cls: "inkbook-adaptive-panel-back-icon" });
  renderIcon(icon, "arrow-left");
  const label = back.createSpan();
  const update = () => {
    const t = (localization ?? createEnglishLocalization()).t;
    label.textContent = t("editor.ui.back");
    back.setAttribute("aria-label", t("editor.ui.back-options"));
  };
  update();
  registerLocaleUpdate?.(update);
  back.addEventListener("click", onBack);
  back.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onBack();
  });
}
