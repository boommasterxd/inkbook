import { SharedFrameScheduler } from "../../../domain/scheduling/shared-frame-scheduler";

export interface WorkerTimingPort {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
}

export interface WorkerSchedulingProfile {
  readonly sliceMilliseconds: number;
  readonly frameIntervalMilliseconds: number;
}

export function createWorkerWorkScheduler(
  initialProfile: WorkerSchedulingProfile,
  timing: WorkerTimingPort = {
    now: () => performance.now(),
    setTimeout: (callback, milliseconds) => self.setTimeout(callback, milliseconds),
    clearTimeout: (handle) => self.clearTimeout(handle),
  },
) {
  let profile = validateProfile(initialProfile);
  let workScheduler: SharedFrameScheduler | null = null;
  workScheduler = new SharedFrameScheduler({
    now: () => timing.now(),
    budgetMs: () => profile.sliceMilliseconds,
    frameIntervalMs: () => profile.frameIntervalMilliseconds,
    requestFrame: (callback) => {
      const frameStart =
        workScheduler === null ? timing.now() : workScheduler.deadline() - workScheduler.budgetMs();
      const nextFrameAt = frameStart + profile.frameIntervalMilliseconds;
      return timing.setTimeout(
        () => callback(timing.now()),
        Math.max(0, nextFrameAt - timing.now()),
      );
    },
    cancelFrame: (handle) => timing.clearTimeout(handle),
    setTimer: (callback, milliseconds) => timing.setTimeout(callback, milliseconds),
    clearTimer: (handle) => timing.clearTimeout(handle),
    isHidden: () => false,
  });
  return {
    workScheduler,
    updateSchedulingProfile: (sliceMilliseconds: number, frameIntervalMilliseconds: number) => {
      profile = validateProfile({ sliceMilliseconds, frameIntervalMilliseconds });
    },
  };
}

function validateProfile(profile: WorkerSchedulingProfile): WorkerSchedulingProfile {
  if (
    !Number.isFinite(profile.sliceMilliseconds) ||
    profile.sliceMilliseconds <= 0 ||
    !Number.isFinite(profile.frameIntervalMilliseconds) ||
    profile.frameIntervalMilliseconds <= 0
  ) {
    throw new RangeError("Worker scheduling profile must contain positive finite times.");
  }
  return profile;
}
