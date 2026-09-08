import { resolveToolbarLayout, type ToolbarLayoutStage } from "../../../rendering/ui/index";

export function measureToolbarLayout(
  chromeHost: HTMLElement,
  availableWidth: number,
): ToolbarLayoutStage {
  const toolbar = chromeHost.querySelector<HTMLElement>(".inkbook-toolbar");
  if (toolbar === null) return "scrollable";
  const track = toolbar.querySelector<HTMLElement>(".inkbook-toolbar-track");
  return resolveToolbarLayout({
    availableWidth: Math.max(0, availableWidth),
    contentWidth: track?.scrollWidth ?? toolbar.scrollWidth,
  });
}
