import { expect, it, vi } from "vitest";
import { derivePageExtent } from "../../../../../src/domain/geometry/public";
import { ActivePageLayout } from "../../../../../src/obsidian/embeds/active-editor/layout/page-layout";
import { TextSessionExtent } from "../../../../../src/obsidian/embeds/active-editor/text-session-extent";
import type { TextEditingSurface } from "../../../../../src/rendering/scene/text-editing-surface";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";
import { snapshot } from "../../../domain/schema/fixtures";
import { FrameHarness } from "../../../../fixtures/obsidian/navigation";
import { workSchedulerFromFrames } from "../../../../fixtures/obsidian/work-scheduler";

function extentLayoutOptions(
  policy: ActivePageLayout,
  page: ReturnType<typeof snapshot>["page"],
  geometry: () => { y: number; height: number },
) {
  return {
    scheduler: immediateWorkScheduler(),
    surface: {
      setContentHeight: (height: number) => {
        const { y } = geometry();
        return { minX: 0, maxX: 400, minY: y, maxY: y + height };
      },
    } as TextEditingSurface,
    layout: {
      begin: () => policy.beginSelectionMove(),
      updateBottom: (bottom: number) => policy.previewSelectionMove(page, bottom),
      finish: vi.fn((changed: boolean) => {
        const { y, height } = geometry();
        return policy.finishSelectionMove(changed, page, y + height);
      }),
    },
    canonicalHeight: () => geometry().height,
  };
}

it.each([false, true])(
  "preserves page hysteresis after source reveal, unless canonical height changed (%s)",
  (changed) => {
    const page = { ...snapshot().page, background: { type: "lines", spacing: 100 } as const };
    const policy = new ActivePageLayout();
    const original = policy.committed(page, undefined)!.height;
    expect(original).toBe(348.6);
    const y = 174.286;
    let canonicalHeight = 31.1875;
    let contentHeight = 250;
    expect(derivePageExtent(page, y + canonicalHeight).activeHeight).toBe(548.6);
    expect(policy.committed(page, y + canonicalHeight)).toBeUndefined();
    const options = extentLayoutOptions(policy, page, () => ({ y, height: canonicalHeight }));
    const finish = options.layout.finish;
    const extent = new TextSessionExtent({
      ...options,
      input: () => ({ contentHeight, view: { scaleY: 0.5 } }),
    });
    extent.update();
    expect(policy.height).toBeGreaterThan(original);
    const firstGrowth = policy.height!;
    contentHeight += 200;
    extent.update();
    expect(policy.height).toBeGreaterThan(firstGrowth);
    expect(policy.height! - page.margin).toBeGreaterThan(y + contentHeight / 0.5);
    if (changed) canonicalHeight += 400;
    extent.dispose();
    expect(finish).toHaveBeenCalledExactlyOnceWith(changed);
    policy.transitionCompleted();
    policy.transitionCompleted();
    expect(policy.height).toBe(
      changed ? derivePageExtent(page, y + canonicalHeight).activeHeight : original,
    );
    if (changed) expect(policy.height! - page.margin).toBeGreaterThan(y + canonicalHeight);
  },
);

it("publishes settled native source height once and ignores a pending measurement after disposal", () => {
  const frames = new FrameHarness();
  let height = 198_789;
  const pending: (() => void)[] = [];
  const measureContentHeight = vi.fn((complete?: (height: number | undefined) => void) => {
    if (!complete) return height;
    pending.push(() => complete(height));
    return undefined;
  });
  const setContentHeight = vi.fn((value: number) => ({ minX: 0, minY: 0, maxX: 400, maxY: value }));
  const updateBottom = vi.fn();
  const extent = new TextSessionExtent({
    scheduler: workSchedulerFromFrames(frames.window),
    surface: { setContentHeight } as unknown as TextEditingSurface,
    layout: { begin: vi.fn(), updateBottom, finish: vi.fn() },
    input: () => ({ contentHeight: 198_789, view: { scaleY: 0.5 }, measureContentHeight }),
    canonicalHeight: () => 32,
  });
  for (let index = 0; index < 1000; index += 1) extent.invalidate();
  frames.flushAll();
  expect(measureContentHeight).toHaveBeenCalledOnce();
  expect(setContentHeight).not.toHaveBeenCalled();
  for (let index = 0; index < 1000; index += 1) extent.invalidate();
  expect(frames.pending).toBe(0);
  height = 933.094;
  pending.shift()!();
  expect(setContentHeight).toHaveBeenCalledExactlyOnceWith(933.094);
  expect(updateBottom).toHaveBeenCalledExactlyOnceWith(933.094, false, true);
  extent.invalidate();
  frames.flushAll();
  expect(measureContentHeight).toHaveBeenCalledTimes(2);
  extent.dispose();
  pending.shift()!();
  expect(setContentHeight).toHaveBeenCalledOnce();
  extent.invalidate();
  expect(frames.pending).toBe(0);
});

it.each([false, true])(
  "retains source extent through a nested resize and restores the proper canonical bottom (%s)",
  (committed) => {
    const page = snapshot().page;
    const policy = new ActivePageLayout();
    const original = policy.committed(page, undefined)!.height;
    let y = 100;
    const height = 32;
    let contentHeight = 1000;
    const extent = new TextSessionExtent({
      ...extentLayoutOptions(policy, page, () => ({ y, height })),
      input: () => ({ contentHeight, view: { scaleY: 1 } }),
    });
    extent.update();
    policy.transitionCompleted();
    policy.beginSelectionMove();
    if (committed) y = 500;
    policy.finishSelectionMove(committed, page, y + height);
    expect(policy.selectionMoveActive).toBe(true);
    const firstGrowth = policy.height!;
    contentHeight = 2000;
    extent.update();
    policy.transitionCompleted();
    expect(policy.height).toBeGreaterThan(firstGrowth);
    extent.dispose();
    policy.transitionCompleted();
    expect(policy.selectionMoveActive).toBe(false);
    expect(policy.height).toBe(
      committed ? derivePageExtent(page, y + height).activeHeight : original,
    );
    expect(policy.finishSelectionMove(false, page, undefined)).toBeUndefined();
    expect(policy.committed(page, 4000)).toBeDefined();
  },
);
