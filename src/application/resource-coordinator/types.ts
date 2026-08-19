export const RESOURCE_CATEGORIES_V1 = Object.freeze({
  attachedView: "attached-view",
  animationFrame: "animation-frame",
  asyncContinuation: "async-continuation",
  domNode: "dom-node",
  frameworkRoot: "framework-root",
  hostHistoryEmergency: "host-history-emergency",
  hostHistoryRecord: "host-history-record",
  indexedDbQueueTurn: "indexed-db-queue-turn",
  lifecycleEmergency: "lifecycle-emergency",
  listener: "listener",
  messagePortOwner: "message-port-owner",
  noteSession: "note-session",
  observer: "observer",
  persistencePipeline: "persistence-pipeline",
  pointerCapture: "pointer-capture",
  readingViewChild: "reading-view-child",
  readingViewObserver: "reading-view-observer",
  readingViewReport: "reading-view-report",
  recoveryRecord: "recovery-record",
  sessionTurn: "session-turn",
  subscription: "subscription",
  timer: "timer",
  workerCancellation: "worker-cancellation",
  workerDetachedBuffer: "worker-detached-buffer",
  workerInput: "worker-input",
  workerMessage: "worker-message",
  workerOutput: "worker-output",
  workerOwner: "worker-owner",
  workerQueuedJob: "worker-queued-job",
  workerResident: "worker-resident",
  workerScratch: "worker-scratch",
  workerTransfer: "worker-transfer",
} as const);

export type ResourceCategoryV1 =
  (typeof RESOURCE_CATEGORIES_V1)[keyof typeof RESOURCE_CATEGORIES_V1];
export type ResourceResidencyV1 = "steady" | "transient";
type ResourceLimitDispositionV1 = "reject" | "suspend";

export interface ResourceChargeV1 {
  readonly bytes: number;
  readonly count: number;
}

export interface ResourceScopeV1 {
  readonly id: string;
  readonly kind: "session" | "view";
}

export interface ResourceAdmissionRequestV1 extends ResourceChargeV1 {
  readonly category: ResourceCategoryV1;
  readonly disposition?: ResourceLimitDispositionV1;
  readonly ownerId: string;
  readonly residency: ResourceResidencyV1;
  readonly scope?: ResourceScopeV1;
}

export interface ResourceCategoryLimitV1 {
  readonly baseBytes?: number;
  readonly bytes?: number;
  readonly count?: number;
  readonly group?: string;
  readonly perScopeBytes?: number;
  readonly perScopeCount?: number;
}

export interface ResourceBudgetProfileV1 {
  readonly categoryLimits: Readonly<
    Partial<Record<ResourceCategoryV1, ResourceCategoryLimitV1>>
  >;
  readonly emergencyPayloadBytes: number;
  readonly groupLimits: Readonly<Record<string, ResourceCategoryLimitV1>>;
  readonly platform: "desktop-or-android-tablet" | "android-phone";
  readonly steadyResidentBytes: number;
  readonly transientResidentBytes: number;
}

export interface ResourceCategorySnapshotV1 {
  readonly current: ResourceChargeV1;
  readonly highWater: ResourceChargeV1;
  readonly rejected: ResourceChargeV1;
  readonly released: ResourceChargeV1;
  readonly reserved: ResourceChargeV1;
  readonly suspended: ResourceChargeV1;
}

export interface ResourceCoordinatorSnapshotV1 {
  readonly balanced: boolean;
  readonly categories: Readonly<
    Partial<Record<ResourceCategoryV1, ResourceCategorySnapshotV1>>
  >;
  readonly current: ResourceChargeV1;
  readonly disposed: boolean;
  readonly highWater: ResourceChargeV1;
  readonly rejected: ResourceChargeV1;
  readonly released: ResourceChargeV1;
  readonly reserved: ResourceChargeV1;
  readonly suspended: ResourceChargeV1;
}

export type ResourceAdmissionFailureReasonV1 =
  | "category-byte-limit"
  | "category-count-limit"
  | "disposed"
  | "emergency-payload-limit"
  | "emergency-slot-busy"
  | "group-byte-limit"
  | "group-count-limit"
  | "invalid-request"
  | "scope-byte-limit"
  | "scope-count-limit"
  | "steady-byte-limit"
  | "transient-byte-limit";

export interface ResourceAdmissionHandleV1 {
  readonly bytes: number;
  readonly category: ResourceCategoryV1;
  readonly count: number;
  readonly ownerId: string;
  readonly state: "reserved" | "current" | "released";
  activate(): boolean;
  release(): boolean;
  transfer(ownerId: string): boolean;
}

export type ResourceAdmissionResultV1<THandle = ResourceAdmissionHandleV1> =
  | { readonly kind: "admitted"; readonly handle: THandle }
  | {
      readonly kind: "rejected" | "suspended";
      readonly reason: ResourceAdmissionFailureReasonV1;
    };

export interface AsyncResourceAdmissionRequestV1 {
  readonly completionBytes: number;
  readonly operation: ResourceAdmissionRequestV1;
}

export interface BatchResourceAdmissionRequestV1 {
  readonly completionBytes?: number;
  readonly operations: readonly ResourceAdmissionRequestV1[];
}

export interface BatchResourceHandleV1 {
  readonly state: "reserved" | "active" | "completion" | "released";
  activate(): boolean;
  publishCompletion(ownerId?: string): boolean;
  release(): boolean;
  transfer(ownerId: string): boolean;
}

export interface AsyncResourceHandleV1 {
  readonly state: "reserved" | "active" | "completion" | "released";
  activate(): boolean;
  publishCompletion(ownerId?: string): boolean;
  release(): boolean;
  transfer(ownerId: string): boolean;
}

export type EmergencyTurnKindV1 = "lifecycle" | "host-history";

export interface EmergencyTurnHandleV1 {
  readonly kind: EmergencyTurnKindV1;
  readonly ownerId: string;
  readonly released: boolean;
  release(): boolean;
  transfer(ownerId: string): boolean;
}

export interface SessionResourceHandleV1 {
  readonly sessionId: string;
  readonly released: boolean;
  admitEmergency(
    kind: EmergencyTurnKindV1,
    payloadBytes: number,
    ownerId?: string,
  ): ResourceAdmissionResultV1<EmergencyTurnHandleV1>;
  release(): boolean;
}
