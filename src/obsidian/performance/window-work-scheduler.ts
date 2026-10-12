import { HostTaskQueue, createHostTaskChannel } from "../../domain/scheduling/host-task-queue";
import type { HostTaskChannel } from "../../domain/scheduling/host-task-queue";
import { SharedFrameScheduler } from "../../domain/scheduling/shared-frame-scheduler";
import type { WorkScheduler } from "../../domain/scheduling/work-scheduler";

/** The sole native frame adapter for cooperative work in an Obsidian window. */
export function createWindowWorkScheduler(
  ownerWindow: Window,
  profile: () => { readonly sliceBudgetMs: number; readonly frameDurationMs: number },
): WorkScheduler {
  const performance = ownerWindow.performance;
  const tasks = new HostTaskQueue({
    openChannel: (receive) => openWindowTaskChannel(ownerWindow, receive),
    setTimer: (callback, delay) => ownerWindow.setTimeout(callback, delay),
    clearTimer: (handle) => ownerWindow.clearTimeout(handle),
  });
  return new SharedFrameScheduler({
    now: () => performance.now(),
    budgetMs: () => profile().sliceBudgetMs,
    frameIntervalMs: () => profile().frameDurationMs,
    requestFrame: (callback) => ownerWindow.requestAnimationFrame(callback),
    cancelFrame: (handle) => ownerWindow.cancelAnimationFrame(handle),
    setTimer: (callback, delay) => tasks.schedule(callback, delay),
    clearTimer: (handle) => tasks.cancel(handle),
    isHidden: () => ownerWindow.document.visibilityState === "hidden",
    dispose: () => tasks.dispose(),
  });
}

function openWindowTaskChannel(
  ownerWindow: Window,
  receive: () => void,
): HostTaskChannel | undefined {
  const messageChannelConstructor = (
    ownerWindow as Window & { MessageChannel?: typeof MessageChannel }
  ).MessageChannel;
  if (messageChannelConstructor === undefined) return undefined;
  const channel = new messageChannelConstructor();
  return createHostTaskChannel(channel.port1, channel.port2, receive);
}
