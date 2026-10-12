import type { PageV1 } from "../../../domain/schema/public";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { ToolbarLayoutStage } from "../../../rendering/ui/index";
import type { ActiveEditorResizeAnchor, ActiveEditorResizeUpdate } from "./layout-resize";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import type { NavigationLayoutRead } from "./navigation-layout";

export interface ActiveEditorLayoutOptions {
  readonly workScheduler: WorkScheduler;
  readonly beginScrollStability?: () => () => void;
  readonly chromeHost: HTMLElement;
  readonly container: HTMLElement;
  readonly onLayout: (layout: ToolbarLayoutStage) => void;
  readonly onReady: () => void;
  readonly onResize?: (update: ActiveEditorResizeUpdate) => void;
  readonly onZoom: (zoom: number) => void;
  readonly page: () => PageV1;
  readonly readResizeAnchor?: () => ActiveEditorResizeAnchor | undefined;
  readonly readNavigationLayout?: () => NavigationLayoutRead | undefined;
  readonly readHostGeometryRevision?: () => number;
  readonly renderer: SvgSceneRenderer;
  readonly root: HTMLElement;
  readonly storeMaximumBottom: () => number | undefined;
}
