import { describe, expect, it } from "vitest";
import {
  CLOSED_VERTICES,
  recognizePointPath,
  recognizeSamples,
  sampledPath,
} from "./recognition-fixtures";
import { roughRectanglePath } from "./rough-rectangle-fixtures";

describe("unresolved closed contours", () => {
  it("rejects a second complete circuit even when every point lies on the native boundary", () => {
    const circuit = sampledPath(CLOSED_VERTICES.rectangle);
    expect(recognizeSamples([...circuit, ...circuit.slice(3)])).toBeNull();
  });

  it("keeps a dented loop raw instead of turning its closing seam into a diamond-headed arrow", () => {
    const points = roughRectanglePath([
      [0, 0],
      [40, 12],
      [80, 0],
      [80, 80],
      [0, 80],
      [0, 0],
      [-8, -8],
    ]);
    expect(recognizePointPath(points)).toBeNull();
  });
});
