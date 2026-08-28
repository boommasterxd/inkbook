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
    const unregister = registerInkbookIcons();

    expect(testIconRegistry.has(STRAIGHT_HIGHLIGHTER_ICON_ID)).toBe(true);
    expect(testIconRegistry.get(CAUTION_ERASER_ICON_ID)).toContain("var(--color-orange)");
    expect(testIconRegistry.get(OPACITY_ICON_ID)).toContain('opacity="0.22"');
    expect(testIconRegistry.get(OPACITY_ICON_ID)?.match(/<circle/g)).toHaveLength(4);
    expect(testIconRegistry.get(PRESSURE_SENSITIVITY_ICON_ID)).toContain('fill="currentColor"');
    expect(testIconRegistry.get(PRESSURE_SENSITIVITY_ICON_ID)).toContain(
      'viewBox="-16 -16 386 384"',
    );
    expect(testIconRegistry.get(BACKGROUND_SQUARES_ICON_ID)).toContain('stroke-linejoin="miter"');
    expect(testIconRegistry.get(BACKGROUND_SQUARES_ICON_ID)).toContain(
      "M3 3h18v18H3zM9 3v18m6-18v18M3 9h18m-18 6h18",
    );
    for (const iconId of Object.values(SHAPE_ICON_IDS)) {
      expect(testIconRegistry.get(iconId)).toContain('viewBox="0 0 24 24"');
    }
    expect(testIconRegistry.get(SHAPE_ICON_IDS.table)).toContain("M4 9h16M12 4v16");
    expect(testIconRegistry.get(SHAPE_ICON_IDS.table)).not.toContain("<rect");
    for (const start of ARROW_NODES) {
      for (const end of ARROW_NODES) {
        expect(testIconRegistry.get(arrowShapeIconId(start, end))).toContain('viewBox="0 0 24 24"');
      }
    }
    expect(testIconRegistry.get(coordinateSystemIconId("2d"))).not.toBe(
      testIconRegistry.get(coordinateSystemIconId("3d")),
    );

    unregister();
    expect(testIconRegistry.size).toBe(0);
    unregister();
    expect(testIconRegistry.size).toBe(0);
  });
});
