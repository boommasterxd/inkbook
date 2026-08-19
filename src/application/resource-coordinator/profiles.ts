import {
  RESOURCE_CATEGORIES_V1,
  type ResourceBudgetProfileV1,
  type ResourceCategoryLimitV1,
} from "./types";

const KIB = 1_024;
const MIB = KIB * KIB;
const EMERGENCY_KIB = 64;
const EMERGENCY_BYTES = EMERGENCY_KIB * KIB;
const DOM_CHARGE = 512;
const OBSERVER_KIB = 2;
const OBSERVER_CHARGE = OBSERVER_KIB * KIB;
const WORKER_OWNER_KIB = 16;
const WORKER_OWNER_CHARGE = WORKER_OWNER_KIB * KIB;
const FRAMEWORK_ROOT_KIB = 64;
const FRAMEWORK_ROOT_CHARGE = FRAMEWORK_ROOT_KIB * KIB;
const CONTINUATION_CHARGE = KIB;
const MAX_DOM_NODES_PER_VIEW = 4_000;
const MAX_VIEW_LIFECYCLE_RESOURCES = 32;
const MAX_PLUGIN_LISTENERS = 256;
const MAX_VIEW_LISTENERS = 128;
const MAX_PLUGIN_CONTINUATIONS = 256;
const MAX_SESSION_CONTINUATIONS = 64;
const MAX_WORKER_JOBS = 64;
const MAX_WORKER_QUEUE_MIB = 16;
const MAX_RECOVERY_RECORDS = 4_096;
const MAX_INDEXED_DB_TURNS = 2;
const APPLICATION_FRAMEWORK_ROOTS = 4;
const MAX_HISTORY_MIB_PER_VIEW = 32;
const WORKER_GROUP = "worker-resident";
const LISTENER_GROUP = "listener-or-subscription";
const DESKTOP_PERSISTENCE_MIB = 128;
const DESKTOP_PLUGIN_TURN_MIB = 16;
const DESKTOP_SESSION_TURN_MIB = 4;
const DESKTOP_SESSION_LIMIT = 16;
const DESKTOP_STEADY_MIB = 128;
const DESKTOP_TRANSIENT_MIB = 192;
const DESKTOP_WORKER_MIB = 48;
const PHONE_PERSISTENCE_MIB = 64;
const PHONE_PLUGIN_TURN_MIB = 8;
const PHONE_SESSION_TURN_MIB = 2;
const PHONE_SESSION_LIMIT = 8;
const PHONE_STEADY_MIB = 96;
const PHONE_TRANSIENT_MIB = 160;
const PHONE_WORKER_MIB = 32;

interface ProfileConfig {
  readonly persistenceBytes: number;
  readonly persistenceCount: number;
  readonly platform: ResourceBudgetProfileV1["platform"];
  readonly pluginTurnBytes: number;
  readonly pluginTurnCount: number;
  readonly readingViewLimit: number;
  readonly sessionLimit: number;
  readonly sessionTurnBytes: number;
  readonly sessionTurnCount: number;
  readonly steadyResidentBytes: number;
  readonly transientResidentBytes: number;
  readonly workerBytes: number;
  readonly workerCount: number;
}

function limits(
  values: Record<string, ResourceCategoryLimitV1>,
): Readonly<Record<string, ResourceCategoryLimitV1>> {
  return Object.freeze(
    Object.fromEntries(
      Object.entries(values).map(([category, limit]) => [
        category,
        Object.freeze(limit),
      ]),
    ),
  );
}

function lifecycleLimits(): Record<string, ResourceCategoryLimitV1> {
  return {
    [RESOURCE_CATEGORIES_V1.domNode]: {
      baseBytes: DOM_CHARGE,
      perScopeCount: MAX_DOM_NODES_PER_VIEW,
    },
    [RESOURCE_CATEGORIES_V1.listener]: {
      baseBytes: DOM_CHARGE,
      group: LISTENER_GROUP,
    },
    [RESOURCE_CATEGORIES_V1.subscription]: {
      baseBytes: DOM_CHARGE,
      group: LISTENER_GROUP,
    },
    [RESOURCE_CATEGORIES_V1.observer]: {
      baseBytes: OBSERVER_CHARGE,
      perScopeCount: MAX_VIEW_LIFECYCLE_RESOURCES,
    },
    [RESOURCE_CATEGORIES_V1.timer]: {
      baseBytes: DOM_CHARGE,
      perScopeCount: MAX_VIEW_LIFECYCLE_RESOURCES,
    },
    [RESOURCE_CATEGORIES_V1.animationFrame]: {
      baseBytes: DOM_CHARGE,
      perScopeCount: MAX_VIEW_LIFECYCLE_RESOURCES,
    },
    [RESOURCE_CATEGORIES_V1.pointerCapture]: {
      baseBytes: DOM_CHARGE,
      perScopeCount: MAX_VIEW_LIFECYCLE_RESOURCES,
    },
  };
}

function workerLimits(
  config: ProfileConfig,
): Record<string, ResourceCategoryLimitV1> {
  const grouped = { group: WORKER_GROUP };
  return {
    [RESOURCE_CATEGORIES_V1.workerResident]: {
      bytes: config.workerBytes,
      ...grouped,
    },
    [RESOURCE_CATEGORIES_V1.workerOwner]: {
      baseBytes: WORKER_OWNER_CHARGE,
      count: config.workerCount,
      ...grouped,
    },
    [RESOURCE_CATEGORIES_V1.messagePortOwner]: {
      baseBytes: WORKER_OWNER_CHARGE,
      count: config.workerCount,
      ...grouped,
    },
    [RESOURCE_CATEGORIES_V1.workerQueuedJob]: {
      bytes: MAX_WORKER_QUEUE_MIB * MIB,
      count: MAX_WORKER_JOBS,
      ...grouped,
    },
    [RESOURCE_CATEGORIES_V1.workerInput]: grouped,
    [RESOURCE_CATEGORIES_V1.workerOutput]: grouped,
    [RESOURCE_CATEGORIES_V1.workerScratch]: grouped,
    [RESOURCE_CATEGORIES_V1.workerTransfer]: grouped,
    [RESOURCE_CATEGORIES_V1.workerDetachedBuffer]: grouped,
    [RESOURCE_CATEGORIES_V1.workerCancellation]: grouped,
    [RESOURCE_CATEGORIES_V1.workerMessage]: grouped,
  };
}

function applicationLimits(
  config: ProfileConfig,
): Record<string, ResourceCategoryLimitV1> {
  return {
    [RESOURCE_CATEGORIES_V1.noteSession]: {
      count: config.sessionLimit,
      perScopeCount: 1,
    },
    [RESOURCE_CATEGORIES_V1.attachedView]: { count: config.sessionLimit },
    [RESOURCE_CATEGORIES_V1.persistencePipeline]: {
      bytes: config.persistenceBytes,
      count: config.persistenceCount,
    },
    [RESOURCE_CATEGORIES_V1.sessionTurn]: {
      bytes: config.pluginTurnBytes,
      count: config.pluginTurnCount,
      perScopeBytes: config.sessionTurnBytes,
      perScopeCount: config.sessionTurnCount,
    },
    [RESOURCE_CATEGORIES_V1.asyncContinuation]: {
      baseBytes: CONTINUATION_CHARGE,
      count: MAX_PLUGIN_CONTINUATIONS,
      perScopeCount: MAX_SESSION_CONTINUATIONS,
    },
    [RESOURCE_CATEGORIES_V1.frameworkRoot]: {
      baseBytes: FRAMEWORK_ROOT_CHARGE,
      count: config.sessionLimit + APPLICATION_FRAMEWORK_ROOTS,
    },
    [RESOURCE_CATEGORIES_V1.hostHistoryRecord]: {
      perScopeBytes: MAX_HISTORY_MIB_PER_VIEW * MIB,
    },
    [RESOURCE_CATEGORIES_V1.recoveryRecord]: {
      count: MAX_RECOVERY_RECORDS,
    },
    [RESOURCE_CATEGORIES_V1.indexedDbQueueTurn]: {
      perScopeCount: MAX_INDEXED_DB_TURNS,
    },
  };
}

function viewAndEmergencyLimits(
  config: ProfileConfig,
): Record<string, ResourceCategoryLimitV1> {
  const emergency = {
    bytes: config.sessionLimit * EMERGENCY_BYTES,
    count: config.sessionLimit,
    perScopeBytes: EMERGENCY_BYTES,
    perScopeCount: 1,
  };
  return {
    [RESOURCE_CATEGORIES_V1.readingViewChild]: {
      perScopeCount: config.readingViewLimit,
    },
    [RESOURCE_CATEGORIES_V1.readingViewReport]: {
      perScopeCount: config.readingViewLimit,
    },
    [RESOURCE_CATEGORIES_V1.readingViewObserver]: {
      baseBytes: OBSERVER_CHARGE,
      perScopeCount: config.readingViewLimit,
    },
    [RESOURCE_CATEGORIES_V1.lifecycleEmergency]: emergency,
    [RESOURCE_CATEGORIES_V1.hostHistoryEmergency]: emergency,
  };
}

function createProfile(config: ProfileConfig): ResourceBudgetProfileV1 {
  return Object.freeze({
    categoryLimits: limits({
      ...applicationLimits(config),
      ...lifecycleLimits(),
      ...viewAndEmergencyLimits(config),
      ...workerLimits(config),
    }),
    emergencyPayloadBytes: EMERGENCY_BYTES,
    groupLimits: limits({
      [LISTENER_GROUP]: {
        count: MAX_PLUGIN_LISTENERS,
        perScopeCount: MAX_VIEW_LISTENERS,
      },
      [WORKER_GROUP]: { bytes: config.workerBytes },
    }),
    platform: config.platform,
    steadyResidentBytes: config.steadyResidentBytes,
    transientResidentBytes: config.transientResidentBytes,
  });
}

export const RESOURCE_BUDGET_V1 = Object.freeze({
  desktopOrAndroidTablet: createProfile({
    persistenceBytes: DESKTOP_PERSISTENCE_MIB * MIB,
    persistenceCount: 2,
    platform: "desktop-or-android-tablet",
    pluginTurnBytes: DESKTOP_PLUGIN_TURN_MIB * MIB,
    pluginTurnCount: 1_024,
    readingViewLimit: 1_024,
    sessionLimit: DESKTOP_SESSION_LIMIT,
    sessionTurnBytes: DESKTOP_SESSION_TURN_MIB * MIB,
    sessionTurnCount: 256,
    steadyResidentBytes: DESKTOP_STEADY_MIB * MIB,
    transientResidentBytes: DESKTOP_TRANSIENT_MIB * MIB,
    workerBytes: DESKTOP_WORKER_MIB * MIB,
    workerCount: 4,
  }),
  androidPhone: createProfile({
    persistenceBytes: PHONE_PERSISTENCE_MIB * MIB,
    persistenceCount: 1,
    platform: "android-phone",
    pluginTurnBytes: PHONE_PLUGIN_TURN_MIB * MIB,
    pluginTurnCount: 512,
    readingViewLimit: 512,
    sessionLimit: PHONE_SESSION_LIMIT,
    sessionTurnBytes: PHONE_SESSION_TURN_MIB * MIB,
    sessionTurnCount: 128,
    steadyResidentBytes: PHONE_STEADY_MIB * MIB,
    transientResidentBytes: PHONE_TRANSIENT_MIB * MIB,
    workerBytes: PHONE_WORKER_MIB * MIB,
    workerCount: 2,
  }),
});
