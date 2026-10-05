import { HostTaskQueue } from "../../../domain/scheduling/host-task-queue";
import type { HostTaskChannel } from "../../../domain/scheduling/host-task-queue";
import { SharedFrameScheduler } from "../../../domain/scheduling/shared-frame-scheduler";

export interface WorkerTimingPort {
  now(): number;
  setTimeout(callback: () => void, milliseconds: number): number;
  clearTimeout(handle: number): void;
  openChannel?(receive: () => void): HostTaskChannel | undefined;
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
    openChannel: (receive) => openWorkerTaskChannel(receive),
  },
) {
  let profile = validateProfile(initialProfile);
  const tasks = new HostTaskQueue({
    openChannel: (receive) => timing.openChannel?.(receive),
    setTimer: (callback, milliseconds) => timing.setTimeout(callback, milliseconds),
    clearTimer: (handle) => timing.clearTimeout(handle),
  });
  const workScheduler = new SharedFrameScheduler({
    continuationMode: "task",
    now: () => timing.now(),
    budgetMs: () => profile.sliceMilliseconds,
    frameIntervalMs: () => profile.frameIntervalMilliseconds,
    requestFrame: (callback) => tasks.schedule(() => callback(timing.now()), 0),
    cancelFrame: (handle) => tasks.cancel(handle),
    setTimer: (callback, milliseconds) => tasks.schedule(callback, milliseconds),
    clearTimer: (handle) => tasks.cancel(handle),
    isHidden: () => false,
    dispose: () => tasks.dispose(),
  });
  return {
    workScheduler,
    updateSchedulingProfile: (sliceMilliseconds: number, frameIntervalMilliseconds: number) => {
      profile = validateProfile({ sliceMilliseconds, frameIntervalMilliseconds });
    },
  };
}

function openWorkerTaskChannel(receive: () => void): HostTaskChannel | undefined {
  if (typeof MessageChannel === "undefined") return undefined;
  const channel = new MessageChannel();
  channel.port1.onmessage = receive;
  return {
    post: () => channel.port2.postMessage(null),
    close: () => {
      channel.port1.onmessage = null;
      channel.port1.close();
      channel.port2.close();
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
