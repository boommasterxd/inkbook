import { vi } from "vitest";
import * as strokePosition from "../../../src/domain/geometry/stroke-position";

/** Count the real geometry boundary without rebuilding mock history arrays for every point. */
export function observeStrokePointBuilds() {
  const work = { points: 0, maximumHistory: 0, historyClears: 0 };
  const actualPoint = strokePosition.strokeWorldPoint;
  const geometry = vi.spyOn(strokePosition, "strokeWorldPoint").mockImplementation((...args) => {
    work.points += 1;
    work.maximumHistory = Math.max(work.maximumHistory, geometry.mock.calls.length);
    // This bounds test instrumentation only; it does not interrupt production work.
    if (geometry.mock.calls.length >= 256) {
      work.historyClears += 1;
      geometry.mockClear();
    }
    return actualPoint(...args);
  });
  return { work, restore: () => geometry.mockRestore() };
}
