import { describe, expect, it } from "vitest";

import type { InkElementV1 } from "../../../../src/domain/schema/public";
import { summarizeStructuralStyle } from "../../../../src/editor/selection/structural-style";
import { coordinateSystem, table as tableFixture } from "../../domain/geometry/fixtures";

function system(id: string, dimension: "2d" | "3d") {
  return { ...coordinateSystem(dimension), id };
}

function table(id: string, columns: number) {
  return tableFixture({ id, columns });
}

describe("structural selection Style summary", () => {
  it("exposes a common coordinate-system dimension", () => {
    expect(summarizeStructuralStyle([system("a", "2d"), system("b", "2d")])).toEqual({
      kind: "coordinate-system",
      dimension: "2d",
    });
  });

  it("reports mixed structural values until one is selected", () => {
    expect(summarizeStructuralStyle([system("a", "2d"), system("b", "3d")])).toEqual({
      kind: "coordinate-system",
      dimension: "mixed",
    });
    expect(summarizeStructuralStyle([table("a", 2), table("b", 4)])).toEqual({
      kind: "table",
      columns: "mixed",
    });
  });

  it("hides controls for empty or mixed-kind selections", () => {
    expect(summarizeStructuralStyle([])).toBeNull();
    expect(
      summarizeStructuralStyle([system("a", "2d"), table("b", 3)] as InkElementV1[]),
    ).toBeNull();
  });
});
