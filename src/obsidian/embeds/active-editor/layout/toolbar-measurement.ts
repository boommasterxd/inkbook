import { resolveToolbarLayout, type ToolbarLayoutStage } from "../../../../rendering/ui/index";

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

/** Retains toolbar-stage convergence without measuring clean chrome on height-only updates. */
export class ToolbarLayoutMeasurement {
  #dirty = true;
  #stage: ToolbarLayoutStage | undefined;

  public invalidate(): void {
    this.#dirty = true;
  }

  public measure(chromeHost: HTMLElement, width: number, widthChanged: boolean) {
    if (!widthChanged && !this.#dirty && this.#stage !== undefined) {
      return { changed: false, stage: this.#stage };
    }
    this.#dirty = false;
    const stage = measureToolbarLayout(chromeHost, width);
    const changed = stage !== this.#stage;
    this.#stage = stage;
    return { changed, stage };
  }
}
