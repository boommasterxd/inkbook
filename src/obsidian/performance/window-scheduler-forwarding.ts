import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

type ForwardedWorkScheduler = Omit<WorkScheduler, "checkpoint" | "nextFrame">;

/** Forwards ordinary work and tracks frame handles across owning-window changes. */
export function createWindowSchedulerForwarding(
  current: () => WorkScheduler,
): ForwardedWorkScheduler {
  const frames = new Map<number, { scheduler: WorkScheduler; handle: number }>();
  let nextHandle = 0;
  return {
    now: () => current().now(),
    deadline: () => current().deadline(),
    budgetMs: () => current().budgetMs(),
    shouldYield: () => current().shouldYield(),
    requestFrame: (callback, priority) => {
      const scheduler = current();
      const handle = ++nextHandle;
      const scheduled = scheduler.requestFrame((time) => {
        frames.delete(handle);
        callback(time);
      }, priority);
      frames.set(handle, { scheduler, handle: scheduled });
      return handle;
    },
    cancelFrame: (handle) => {
      const frame = frames.get(handle);
      if (frame === undefined) return;
      frames.delete(handle);
      frame.scheduler.cancelFrame(frame.handle);
    },
    dispose: () => {
      for (const frame of frames.values()) frame.scheduler.cancelFrame(frame.handle);
      frames.clear();
    },
  };
}
