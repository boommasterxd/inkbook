import { expect, it, vi } from "vitest";
import { OnboardingBackground } from "../../../../../src/obsidian/embeds/active-editor/onboarding-background";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

function fixture() {
  const frames = new Map<number, FrameRequestCallback>();
  let id = 0;
  let proof: number | undefined;
  const setMinimumBlockSize = vi.fn();
  const scheduler = workSchedulerFromFrames({
    requestAnimationFrame: (callback) => {
      frames.set(++id, callback);
      return id;
    },
    cancelAnimationFrame: (handle) => frames.delete(handle),
  });
  const background = new OnboardingBackground(scheduler, {
    setMinimumBlockSize,
    readCommitProof: () => proof,
  });
  const flush = () => {
    const pending = [...frames.values()];
    frames.clear();
    pending.forEach((callback) => callback(0));
  };
  return {
    background,
    frames,
    flush,
    setMinimumBlockSize,
    commit: (value: number) => {
      proof = value;
    },
  };
}

it("reveals added paper only after a stable background commit has had a paint opportunity", () => {
  const current = fixture();
  const ready = vi.fn();
  current.background.prepare(360, ready);
  expect(current.setMinimumBlockSize).toHaveBeenCalledExactlyOnceWith(360);
  current.flush();
  expect(ready).not.toHaveBeenCalled();
  current.commit(1);
  current.flush();
  expect(ready).not.toHaveBeenCalled();
  current.commit(2);
  current.flush();
  expect(ready).not.toHaveBeenCalled();
  current.flush();
  current.flush();
  expect(ready).toHaveBeenCalledOnce();
  expect(current.frames.size).toBe(0);
  current.background.prepare(0, ready);
  expect(current.setMinimumBlockSize).toHaveBeenCalledTimes(1);
  current.background.settle(0);
  expect(current.setMinimumBlockSize).toHaveBeenLastCalledWith(0);
});

it("cancels obsolete preparation on replacement and disposal without retaining queued work", () => {
  const current = fixture();
  const obsolete = vi.fn();
  const replacement = vi.fn();
  current.background.prepare(220, obsolete);
  const stale = [...current.frames.values()];
  current.background.prepare(360, replacement);
  stale.forEach((callback) => callback(0));
  expect(current.frames.size).toBe(1);
  current.commit(1);
  current.flush();
  current.flush();
  expect(obsolete).not.toHaveBeenCalled();
  expect(replacement).toHaveBeenCalledOnce();
  current.background.prepare(220, obsolete);
  expect(current.setMinimumBlockSize).toHaveBeenLastCalledWith(360);
  current.flush();
  const retiring = [...current.frames.values()];
  current.background.dispose();
  retiring.forEach((callback) => callback(0));
  expect(current.frames.size).toBe(0);
  expect(obsolete).not.toHaveBeenCalled();
  expect(current.setMinimumBlockSize).toHaveBeenLastCalledWith(0);
});
