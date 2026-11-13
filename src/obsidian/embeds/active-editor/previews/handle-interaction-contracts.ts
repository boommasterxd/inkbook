import type { PointV1 } from "../../../../domain/schema/public";
import type { SnappingSettingsV1 } from "../../../../domain/settings/types";
import type { WorkScheduler } from "../../../../domain/scheduling/work-scheduler";
import type { TextReflow } from "../../../../editor/selection/transform/text-reflow-session";
import type { SelectionFrameSession } from "../../../../editor/selection/public";
import type { EditableDocumentModel } from "../../document-session/vault-document-session";
import type { ActiveEditorHistory } from "../history";
import type { PreparedElementHistory } from "../prepared-element-history";
import type { ElementSceneStore } from "../scene-store";
import type { HandleInteractionRenderer } from "./handle-presentation";
import type { SelectionPreviewFrameScheduler } from "./selection-preview-contracts";

export interface ActiveEditorHandleInteractionOptions {
  readonly frameScheduler: SelectionPreviewFrameScheduler;
  readonly workScheduler?: WorkScheduler;
  readonly reflowText?: TextReflow;
  readonly history: ActiveEditorHistory;
  readonly layout?: {
    begin(): void;
    finish(committed: boolean, previewMaximumBottom?: number): void;
    updateBottom(maximumBottom: number): void;
  };
  readonly model: EditableDocumentModel;
  readonly pageToScreen: (point: PointV1) => PointV1;
  readonly preparedHistory: PreparedElementHistory;
  readonly renderer: HandleInteractionRenderer;
  readonly sceneStore: ElementSceneStore;
  readonly selectionFrames?: SelectionFrameSession;
  readonly selection: () => ReadonlySet<string>;
  readonly snapping?: () => SnappingSettingsV1;
  readonly zoom: () => number;
  readonly onGestureSettled?: () => void;
}
