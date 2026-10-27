import { afterEach, expect, it, vi } from "vitest";
import { moveSelection } from "../../../../../src/editor/selection/transform/transforms";
import { SceneSelectionRuns } from "../../../../../src/rendering/scene/presentation/selection-runs";
import {
  SelectionRunPlanning,
  selectionRunPlanMemoryUsage,
  type SelectionRunPlan,
} from "../../../../../src/rendering/scene/presentation/selection-run-plan";
import { SelectionRunTraces } from "../../../../../src/rendering/scene/presentation/selection-run-traces";
import { SelectionRunTargets } from "../../../../../src/rendering/scene/presentation/selection-run-targets";
import { SelectionRunFeedback } from "../../../../../src/rendering/scene/presentation/selection-run-feedback";
import { SelectionRunRebase } from "../../../../../src/rendering/scene/presentation/selection-run-rebase";
import { SceneRunStrokeWidth } from "../../../../../src/rendering/scene/presentation/selection-run-width";
import { applySelectionDelta } from "../../../../fixtures/rendering/selection-runs";
import {
  commit,
  pressure,
  rect,
  scale,
  world,
} from "../../../../fixtures/rendering/selection-run-world";

afterEach(() => vi.restoreAllMocks());

/** Subtract actual neighboring owners without replacing any production memory result. */
function planContribution(owner: SceneSelectionRuns): number {
  const adjacent = [
    vi.spyOn(owner.groups, "memoryUsage"),
    vi.spyOn(SelectionRunTraces.prototype, "memoryUsage"),
    vi.spyOn(SelectionRunTargets.prototype, "memoryUsage"),
    vi.spyOn(SelectionRunFeedback.prototype, "memoryUsage"),
    vi.spyOn(SelectionRunRebase.prototype, "memoryUsage"),
  ];
  const width = vi.spyOn(SceneRunStrokeWidth.prototype, "memoryUsage");
  try {
    const total = owner.memoryUsage();
    const others = adjacent.reduce((sum, probe) => sum + Number(probe.mock.results[0]!.value), 0);
    const paint = width.mock.results[0]!.value as ReturnType<SceneRunStrokeWidth["memoryUsage"]>;
    return (
      total -
      others -
      paint.trackedEntries * 64 -
      paint.trackedPaths * 192 -
      paint.paletteOverrides * 128
    );
  } finally {
    width.mockRestore();
    for (const probe of adjacent) probe.mockRestore();
  }
}

/** The reported plan budget must not traverse member maps or reference arrays. */
function readPlanWithoutTraversal(plan: SelectionRunPlan): number {
  const reject = (): never => {
    throw new Error("Plan memory reads must use cached cardinalities.");
  };
  const probes: { mockRestore(): void }[] = [];
  for (const method of ["values", "entries", "forEach", Symbol.iterator] as const)
    probes.push(vi.spyOn(Map.prototype, method).mockImplementation(reject));
  for (const method of ["reduce", "map", "forEach", Symbol.iterator] as const)
    probes.push(vi.spyOn(Array.prototype, method).mockImplementation(reject));
  try {
    return selectionRunPlanMemoryUsage(plan, true);
  } finally {
    for (let index = 0; index < probes.length; index += 1) probes[index]!.mockRestore();
  }
}

it.each(["commit", "rebase"] as const)(
  "accounts the retained 10,000-member plan after %s releases its planner",
  (transition) => {
    const prepare = vi.spyOn(SceneSelectionRuns.prototype, "prepare");
    const planning = vi.spyOn(SelectionRunPlanning.prototype, "step");
    const selected = [
      pressure(0),
      pressure(1),
      ...Array.from({ length: 9_998 }, (_, i) => rect(i)),
    ];
    const f = world(
      [selected[0]!, rect(30_000), selected[1]!, rect(30_001), ...selected.slice(2)],
      selected,
    );
    const owner = prepare.mock.contexts[0] as SceneSelectionRuns;
    const planner = planning.mock.contexts[0] as SelectionRunPlanning;
    const plan = planner.result!;
    prepare.mockRestore();
    planning.mockRestore();
    try {
      expect(plan.members.size).toBe(10_000);
      expect(plan.groups).toHaveLength(1);
      expect(plan.exceptions).toHaveLength(2);
      expect(plan.snapshots).toHaveLength(256);
      // The groups owner already charges its 9,998 entry references; strings and records are borrowed.
      const bytes = 128 + 10_000 * 48 + (10_000 + 1 + 2 + 2 + 256) * 8 + 64;
      expect(readPlanWithoutTraversal(plan)).toBe(bytes);
      expect(selectionRunPlanMemoryUsage(plan)).toBe(bytes + 9_998 * 8);
      expect(planContribution(owner)).toBe(bytes + 2 * 40);
      if (transition === "commit") {
        commit(f, scale(f, 2, 1));
      } else {
        applySelectionDelta(f, moveSelection(f.selected, { x: 5, y: 3 }));
      }
      f.scheduler.runAll(1000);
      const plannerRead = vi.spyOn(SelectionRunPlanning.prototype, "memoryUsage");
      expect(planContribution(owner)).toBe(bytes + 2 * 40);
      expect(plannerRead).not.toHaveBeenCalled();
      plannerRead.mockRestore();
      f.renderer.setSelectedElements(new Set());
      f.scheduler.runAll(1000);
      expect(planContribution(owner)).toBe(0);
      f.renderer.destroy();
      expect(owner.memoryUsage()).toBe(0);
      expect(f.scheduler.pendingCount).toBe(0);
    } finally {
      f.dispose();
    }
  },
);
