/** Semantic back control shared by nested adaptive panel pages. */
export function createAdaptivePanelHeader(
  scroll: HTMLElement,
  onBack: () => void,
  renderIcon: (element: HTMLElement, icon: string) => void,
): void {
  const header = scroll.createDiv({ cls: "inkbook-adaptive-panel-header" });
  const back = header.createDiv({ cls: "inkbook-adaptive-panel-back" });
  back.tabIndex = 0;
  back.setAttribute("role", "button");
  back.setAttribute("aria-label", "Back to more options");
  const icon = back.createSpan({ cls: "inkbook-adaptive-panel-back-icon" });
  renderIcon(icon, "arrow-left");
  back.createSpan({ text: "Back" });
  back.addEventListener("click", onBack);
  back.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return;
    event.preventDefault();
    onBack();
  });
}
