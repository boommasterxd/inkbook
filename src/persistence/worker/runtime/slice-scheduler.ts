import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { InputActivityGate } from "./input-activity-gate";
import type {
  DocumentRuntimeRequest,
  InputAwareSliceScheduler,
  RuntimeSliceContext,
  RuntimeSliceWorkProfile,
} from "./types";
import { isNavigationSceneRequest } from "./request-admission";

export function runtimeSliceContext(
  scheduler: InputAwareSliceScheduler | null,
  signal: AbortSignal,
  request: DocumentRuntimeRequest,
  waitForForeground?: () => Promise<void> | undefined,
): RuntimeSliceContext | undefined {
  if (scheduler === null && waitForForeground === undefined) return undefined;
  const sliceMilliseconds = scheduler?.getSliceMilliseconds?.bind(scheduler);
  const workProfile = scheduler?.getSliceWorkProfile?.bind(scheduler);
  return {
    checkpoint: () => {
      const pending = scheduler?.checkpoint(
        signal,
        isNavigationSceneRequest(request) ? "frame" : undefined,
      );
      return pending === undefined
        ? waitForForeground?.()
        : pending.then(() => waitForForeground?.());
    },
    ...(sliceMilliseconds === undefined ? {} : { sliceMilliseconds }),
    ...(workProfile === undefined ? {} : { workProfile: workProfile() }),
    signal,
  };
}

interface RequestCheckpointOptions {
  readonly inputGate: InputActivityGate;
  readonly navigationGate: InputActivityGate;
  readonly scheduler: WorkScheduler;
  readonly waitForAdmission?: (pending: Promise<void>) => Promise<void>;
}

export function createMainThreadRequestCheckpoint(
  options: RequestCheckpointOptions,
  signal: AbortSignal,
  request: DocumentRuntimeRequest,
  adoption = false,
): () => Promise<void> | undefined {
  const required = isNavigationSceneRequest(request);
  const exportRequest = request.type === "export-full" || request.type === "export-incremental";
  const priority = required || (!adoption && exportRequest) ? "frame" : "background";
  const checkpoint = (): Promise<void> | undefined => {
    const ready = options.inputGate.waitUntilInactive(signal);
    if (ready !== undefined) return ready.then(checkpoint);
    const navigation = required ? undefined : options.navigationGate.waitUntilInactive(signal);
    if (navigation !== undefined) return navigation.then(checkpoint);
    signal.throwIfAborted();
    const pending =
      priority === "background"
        ? options.scheduler.checkpoint(signal)
        : options.scheduler.shouldYield()
          ? options.scheduler.nextFrame(signal, "frame")
          : undefined;
    return pending?.then(() => signal.throwIfAborted());
  };
  return () => {
    const pending = checkpoint();
    return pending === undefined ? undefined : (options.waitForAdmission?.(pending) ?? pending);
  };
}

export interface SliceSchedulerOptions {
  readonly isInputActive: () => boolean;
  readonly updateSchedulingProfile?: (
    sliceMilliseconds: number,
    frameIntervalMilliseconds: number,
  ) => void;
  readonly workScheduler: WorkScheduler;
}

const DEFAULT_WORK_PROFILE: RuntimeSliceWorkProfile = Object.freeze({
  inputByteLimit: 16 * 1024,
  nodeLimit: 256,
  outputByteLimit: 64 * 1024,
});

export function runtimeSliceWorkProfile(
  sliceMilliseconds: number | undefined,
): RuntimeSliceWorkProfile {
  if (
    sliceMilliseconds === undefined ||
    !Number.isFinite(sliceMilliseconds) ||
    sliceMilliseconds <= 0
  ) {
    return DEFAULT_WORK_PROFILE;
  }
  if (sliceMilliseconds <= 2.75) {
    return { inputByteLimit: 4 * 1024, nodeLimit: 64, outputByteLimit: 16 * 1024 };
  }
  if (sliceMilliseconds <= 4.25) {
    return { inputByteLimit: 6 * 1024, nodeLimit: 96, outputByteLimit: 24 * 1024 };
  }
  if (sliceMilliseconds <= 5.5) {
    return { inputByteLimit: 8 * 1024, nodeLimit: 128, outputByteLimit: 32 * 1024 };
  }
  if (sliceMilliseconds <= 7) {
    return { inputByteLimit: 12 * 1024, nodeLimit: 192, outputByteLimit: 48 * 1024 };
  }
  return DEFAULT_WORK_PROFILE;
}

export class GestureAwareSliceScheduler implements InputAwareSliceScheduler {
  readonly #isInputActive: () => boolean;
  readonly #inputGate: InputActivityGate;
  readonly #updateSchedulingProfile: SliceSchedulerOptions["updateSchedulingProfile"];
  readonly #workScheduler: WorkScheduler;
  #liveInputActive = false;

  public constructor(options: SliceSchedulerOptions) {
    this.#isInputActive = options.isInputActive;
    this.#inputGate = new InputActivityGate(() => this.#inputActive());
    this.#workScheduler = options.workScheduler;
    this.#updateSchedulingProfile = options.updateSchedulingProfile;
  }

  public setLiveInputActive(active: boolean): void {
    this.#liveInputActive = active;
    if (!active) this.#inputGate.notifyInactive();
  }

  public getSliceMilliseconds(): number {
    return this.#workScheduler.budgetMs();
  }

  public setSchedulingProfile(sliceMilliseconds: number, frameIntervalMilliseconds: number): void {
    validateSliceMilliseconds(sliceMilliseconds);
    validateSliceMilliseconds(frameIntervalMilliseconds);
    this.#updateSchedulingProfile?.(sliceMilliseconds, frameIntervalMilliseconds);
  }

  public getSliceWorkProfile(): RuntimeSliceWorkProfile {
    return runtimeSliceWorkProfile(this.getSliceMilliseconds());
  }

  public checkpoint(signal: AbortSignal, priority?: "frame"): Promise<void> | undefined {
    const ready = this.#inputGate.waitUntilInactive(signal);
    if (ready !== undefined) return ready.then(() => this.checkpoint(signal, priority));
    const pending =
      priority === "frame"
        ? this.#workScheduler.shouldYield()
          ? this.#workScheduler.nextFrame(signal, "frame")
          : undefined
        : this.#workScheduler.checkpoint(signal);
    if (pending !== undefined) return pending.then(() => signal.throwIfAborted());
    signal.throwIfAborted();
    return undefined;
  }

  public async run<T>(
    operation: (signal: AbortSignal) => T | Promise<T>,
    signal: AbortSignal,
    priority?: "frame",
  ): Promise<T> {
    const pending = this.checkpoint(signal, priority);
    if (pending !== undefined) await pending;
    return operation(signal);
  }

  #inputActive(): boolean {
    return this.#liveInputActive || this.#isInputActive();
  }
}

function validateSliceMilliseconds(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) {
    throw new RangeError("sliceMilliseconds must be a positive finite number.");
  }
  return value;
}
