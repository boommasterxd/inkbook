import {
  LEFT_HANDED_TOOL_TRANSLATION_PX,
  resolveToolbarLayout,
  type ToolbarLayoutStage,
} from "../../../rendering/ui/index";

export function measureToolbarLayout(
  chromeHost: HTMLElement,
  availableWidth: number,
): ToolbarLayoutStage {
  const toolbar = chromeHost.querySelector<HTMLElement>(".inkbook-toolbar");
  const left = chromeHost.querySelector<HTMLElement>(".inkbook-toolbar-general");
  const center = chromeHost.querySelector<HTMLElement>(".inkbook-toolbar-tools");
  const right = chromeHost.querySelector<HTMLElement>(".inkbook-toolbar-context");
  if (toolbar === null || left === null || center === null || right === null) return "scrollable";
  return resolveToolbarLayout({
    availableWidth: Math.max(0, availableWidth - 16),
    centerWidth: center.getBoundingClientRect().width,
    centerTranslation: toolbar.classList.contains("inkbook-toolbar-left-handed")
      ? LEFT_HANDED_TOOL_TRANSLATION_PX
      : 0,
    leftWidth: left.getBoundingClientRect().width,
    mergedWidth: toolbar.scrollWidth,
    rightWidth: right.getBoundingClientRect().width,
  });
}
