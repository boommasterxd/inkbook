import { afterEach, describe, expect, it } from "vitest";
import { registerInkbookIcons } from "../../../../src/obsidian/icons/inkbook-icons";
import { ARROW_NODES } from "../../../../src/domain/settings/types";
import {
  arrowShapeIconId,
  BACKGROUND_SQUARES_ICON_ID,
  CAUTION_ERASER_ICON_ID,
  coordinateSystemIconId,
  OPACITY_ICON_ID,
  PRESSURE_SENSITIVITY_ICON_ID,
  SHAPE_ICON_IDS,
  STRAIGHT_HIGHLIGHTER_ICON_ID,
} from "../../../../src/rendering/ui/icon-ids";
import { testIconRegistry } from "../../../adapters/obsidian/plugin";

afterEach(() => testIconRegistry.clear());

describe("Inkbook icon registration", () => {
  it("registers every dynamic shape icon and removes only its owned icons", () => {
    testIconRegistry.set("other-plugin-icon", "<svg />");
    const unregister = registerInkbookIcons();

    for (const iconId of [
      STRAIGHT_HIGHLIGHTER_ICON_ID,
      CAUTION_ERASER_ICON_ID,
      OPACITY_ICON_ID,
      PRESSURE_SENSITIVITY_ICON_ID,
      BACKGROUND_SQUARES_ICON_ID,
      ...Object.values(SHAPE_ICON_IDS),
    ]) {
      expect(testIconRegistry.get(iconId)).toBeTruthy();
    }
    for (const start of ARROW_NODES) {
      for (const end of ARROW_NODES) {
        expect(testIconRegistry.get(arrowShapeIconId(start, end))).toBeTruthy();
      }
    }
    expect(testIconRegistry.get(coordinateSystemIconId("2d"))).not.toBe(
      testIconRegistry.get(coordinateSystemIconId("3d")),
    );

    unregister();
    expect([...testIconRegistry]).toEqual([["other-plugin-icon", "<svg />"]]);
    unregister();
    expect([...testIconRegistry]).toEqual([["other-plugin-icon", "<svg />"]]);
  });
});
