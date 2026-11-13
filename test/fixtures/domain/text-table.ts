import type { TextTableLayoutV2 } from "../../../src/domain/schema/types";

/** Each persistence scenario owns an independent two-column, two-row frame. */
export function textTableFrame(sourceLength: number): TextTableLayoutV2 {
  return {
    start: 0,
    end: sourceLength,
    x: 0,
    y: 0,
    width: 100,
    height: 40,
    columns: 2,
    rowHeights: [20, 20],
    borderWidth: 1,
  };
}
