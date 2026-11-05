import type { PointV1, StrokeElementV1, StrokeStyleV1 } from "../../../../domain/schema/public";
import type { HoldToShapeSettingsV1, ToolDefaultsV1 } from "../../../../domain/settings/types";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";
import type { GesturePreviewStart } from "../../../../editor/gestures/public";
import type { LiveStrokeBuilder, LiveStrokeCommit } from "../../../../editor/tools/live-stroke";
import type { LivePathState } from "../../../../rendering/scene/index";
import type { ActiveEditorHistory } from "../history";
import type { EditableDocumentModel } from "../../document-session/document-model-port";
import type { CreationSnapPorts } from "./creation-snapping";

export interface CreationPreviewRenderer {
  clearLiveStroke(): void;
  commitLiveStroke(id: string, prepared?: LiveStrokeCommit): void;
  commitLivePath(id: string): void;
  setLivePath(path: LivePathState | null): void;
  setSnapMarkerPath(d: string | null): void;
  suppressMotionForNextDelta(ids: readonly string[]): void;
  updateLiveStroke(
    preview: ReturnType<LiveStrokeBuilder["preview"]>,
    style: StrokeStyleV1,
    tool: StrokeElementV1["tool"],
  ): void;
}

export interface CreationPreviewOptions {
  readonly defaults: ToolDefaultsV1;
  readonly holdToShape?: HoldToShapeSettingsV1;
  readonly ownerWindow?: Window;
  readonly screenStart?: PointV1;
  readonly now?: () => number;
  readonly onStrokeCapacityReached?: () => void;
  readonly history: ActiveEditorHistory;
  readonly model?: EditableDocumentModel;
  readonly isCurrent?: () => boolean;
  readonly readRevision?: () => number;
  readonly refinementSignal?: AbortSignal;
  readonly identity: { readonly createdAt: number; readonly id: string };
  readonly renderer: CreationPreviewRenderer;
  readonly snap?: CreationSnapPorts;
  readonly strokeInput?: { readonly pressureSource: "pen" | "simulated"; readonly zoom: number };
  readonly workScheduler?: WorkScheduler;
  readonly start: GesturePreviewStart;
}
