import { resolveToolbarLayout, type ToolbarLayoutStage } from "../../../rendering/ui/index";

export function measureToolbarLayout(
  chromeHost: HTMLElement,
  availableWidth: number,
): ToolbarLayoutStage {
  const toolbar = chromeHost.querySelector<HTMLElement>(".inkbook-toolbar");
  if (toolbar === null) return "scrollable";
  return resolveToolbarLayout({
    availableWidth: Math.max(0, availableWidth),
    contentWidth: toolbar.scrollWidth,
  });
}
