import { connectedLine, rectangle } from "../../unit/domain/store/fixtures";

export { PASS_THROUGH_PLANNER as passThroughPlanner } from "../editor/selection-input-fixture";

export function maximumEndpointFixture() {
  const style = {
    outlineColor: { type: "theme-text" as const },
    outlineOpacity: 1,
    outlineStyle: "solid" as const,
    outlineWidth: 2 as const,
  };
  const targets = Array.from({ length: 39 }, (_, index) => ({
    ...rectangle(fixtureId(index), 20 + (index % 8) * 220, 20 + Math.floor(index / 8) * 150),
    createdAt: index,
    style: { ...style, fillColor: null, fillOpacity: 0 },
  }));
  const lines = targets.flatMap((target, targetIndex) =>
    Array.from({ length: 511 }, (_, endpointIndex) => {
      const index = 39 + targetIndex * 511 + endpointIndex;
      return { ...connectedLine(target), createdAt: index, id: fixtureId(index), style };
    }),
  );
  return { elements: [...targets, ...lines], targetIds: targets.map(({ id }) => id) };
}

function fixtureId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}
