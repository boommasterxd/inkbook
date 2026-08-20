import type {
  CanonicalStyleV1,
  ElementBinding,
  ElementId,
  GroupId,
  LinearGeometryV1,
  NonLinearGeometryV1,
  SceneElementValueV1,
  SceneRevision,
} from "../model/index";
import type {
  GroupRecordV1,
  NoteAppearanceV1,
  RuntimeSceneStateV1,
} from "../scene/index";
import type { AnnotationDependencyIndexV1 } from "./dependency-index";
import type { ObjectOrderIndexV1 } from "./object-order-index";

export type OperationId = string & { readonly __brand: "OperationId" };
export type HistoryEntryId = string & { readonly __brand: "HistoryEntryId" };
export type HistoryEpoch = number & { readonly __brand: "HistoryEpoch" };

interface OperationMetaV1 {
  readonly operationId: OperationId;
  readonly historyEntryId: HistoryEntryId;
  readonly direction: "forward" | "inverse";
  readonly expectedSceneRevision: SceneRevision;
  readonly historyEpoch: HistoryEpoch;
}

export interface ComponentReplacementV1<T> {
  readonly elementId: ElementId;
  readonly prior: T;
  readonly replacement: T;
}

interface CreateElementsPatchV1 {
  readonly kind: "create-elements";
  readonly elements: readonly SceneElementValueV1[];
  readonly placement: OrderPlacementV1;
}

interface DeleteElementsPatchV1 {
  readonly kind: "delete-elements";
  readonly elements: readonly SceneElementValueV1[];
  readonly priorPlacement: OrderPlacementV1;
}

interface ReplaceGeometryPatchV1 {
  readonly kind: "replace-geometry";
  readonly changes: readonly ComponentReplacementV1<NonLinearGeometryV1>[];
}

interface ReplaceStylePatchV1 {
  readonly kind: "replace-style";
  readonly changes: readonly ComponentReplacementV1<CanonicalStyleV1>[];
}

interface ReplaceBindingPatchV1 {
  readonly kind: "replace-binding";
  readonly changes: readonly ComponentReplacementV1<ElementBinding>[];
}

interface ReplaceLinearGeometryPatchV1 {
  readonly kind: "replace-linear-geometry";
  readonly changes: readonly ComponentReplacementV1<LinearGeometryV1>[];
}

export interface OrderPlacementV1 {
  readonly movedElementIds: readonly ElementId[];
  readonly predecessorId: ElementId | null;
  readonly successorId: ElementId | null;
}

export interface ObjectOrderIndexStatsV1 {
  readonly visitedNodes: number;
  readonly allocatedNodes: number;
  readonly maximumKeyBits: number;
}

interface ObjectOrderIndexUpdateV1 {
  readonly index: ObjectOrderIndexV1;
  readonly start: number;
  readonly destinationAfterRemoval: number;
  readonly stats: ObjectOrderIndexStatsV1;
}

export type ObjectOrderIndexResultV1 =
  | { readonly ok: true; readonly value: ObjectOrderIndexUpdateV1 }
  | {
      readonly ok: false;
      readonly code: "invalid-placement" | "resource-limit";
    };

interface ReplaceObjectOrderPatchV1 {
  readonly kind: "replace-object-order";
  readonly prior: OrderPlacementV1;
  readonly replacement: OrderPlacementV1;
}

export interface GroupReplacementV1 {
  readonly groupId: GroupId;
  readonly prior: GroupRecordV1 | null;
  readonly replacement: GroupRecordV1 | null;
}

interface ReplaceGroupsPatchV1 {
  readonly kind: "replace-groups";
  readonly changes: readonly GroupReplacementV1[];
}

export interface ReplaceNoteAppearancePatchV1 {
  readonly kind: "replace-note-appearance";
  readonly prior: NoteAppearanceV1;
  readonly replacement: NoteAppearanceV1;
}

export type BatchMemberV1 =
  | CreateElementsPatchV1
  | DeleteElementsPatchV1
  | ReplaceGeometryPatchV1
  | ReplaceStylePatchV1
  | ReplaceBindingPatchV1
  | ReplaceLinearGeometryPatchV1
  | ReplaceObjectOrderPatchV1
  | ReplaceGroupsPatchV1
  | ReplaceNoteAppearancePatchV1;

interface AtomicBatchPatchV1 {
  readonly kind: "atomic-batch";
  readonly operations: readonly BatchMemberV1[];
}

export type AnnotationPatchV1 = BatchMemberV1 | AtomicBatchPatchV1;

export interface AnnotationOperationV1 extends OperationMetaV1 {
  readonly patch: AnnotationPatchV1;
}

export interface AnnotationHistoryEntryV1 {
  readonly historyEntryId: HistoryEntryId;
  readonly historyEpoch: HistoryEpoch;
  readonly forward: AnnotationPatchV1;
  readonly inverse: AnnotationPatchV1;
}

interface AnnotationOperationChangeSetV1 {
  readonly elementIds: readonly ElementId[];
  readonly groupIds: readonly GroupId[];
  readonly objectOrderChanged: boolean;
  readonly noteAppearanceChanged: boolean;
}

interface AnnotationOperationPublicationV1 {
  readonly scene: RuntimeSceneStateV1;
  readonly dependencies: AnnotationDependencyIndexV1;
  readonly changes: AnnotationOperationChangeSetV1;
}

type AnnotationOperationRejectionCodeV1 =
  "invalid-operation" | "stale-scene" | "resource-limit";

export type AnnotationOperationResultV1 =
  | { readonly ok: true; readonly value: AnnotationOperationPublicationV1 }
  | {
      readonly ok: false;
      readonly code: AnnotationOperationRejectionCodeV1;
    };

export type AnnotationPatchResultV1<T> =
  | { readonly ok: true; readonly value: T }
  | {
      readonly ok: false;
      readonly code: "invalid-operation" | "resource-limit";
    };
