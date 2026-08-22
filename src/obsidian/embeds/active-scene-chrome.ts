import type { PendingEditorChrome } from "./editor-chrome-loader";
import type { InkbookEditorChromeProps } from "../../rendering/ui/editor-chrome";

interface ActiveSceneChromeController {
  chromeProps(): InkbookEditorChromeProps;
}

interface ActiveSceneChromeLayout {
  chromeChanged(): void;
}

export interface ActiveSceneChromeElements {
  readonly chromeHost: HTMLDivElement;
  readonly container: HTMLDivElement;
  readonly editorChrome: HTMLDivElement;
}

export function createActiveSceneChromeElements(root: HTMLElement): ActiveSceneChromeElements {
  const editorChrome = root.createDiv({ cls: "inkbook-editor-chrome" });
  const chromeHost = editorChrome.createDiv({ cls: "inkbook-editor-chrome-host" });
  const container = editorChrome.createDiv({ cls: "inkbook-background-container" });
  return { chromeHost, container, editorChrome };
}

export function updateActiveSceneChrome(
  chrome: PendingEditorChrome,
  controller: ActiveSceneChromeController,
  layout: ActiveSceneChromeLayout,
): void {
  chrome.update(controller.chromeProps());
  layout.chromeChanged();
}
