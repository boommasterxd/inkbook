import { afterEach, describe, expect, it } from "vitest";
import { registerInkbookIcons } from "../../../../src/obsidian/icons/inkbook-icons";
import {
  SHAPE_ICON_IDS,
  STRAIGHT_HIGHLIGHTER_ICON_ID,
} from "../../../../src/rendering/ui/icon-ids";
import { testIconRegistry } from "../../../adapters/obsidian/plugin";

afterEach(() => testIconRegistry.clear());

describe("Inkbook icon registration", () => {
  it("registers every dynamic shape icon and removes only its owned icons", () => {
    const unregister = registerInkbookIcons();

    expect(testIconRegistry.has(STRAIGHT_HIGHLIGHTER_ICON_ID)).toBe(true);
    for (const iconId of Object.values(SHAPE_ICON_IDS)) {
      expect(testIconRegistry.get(iconId)).toContain('viewBox="0 0 24 24"');
    }

    unregister();
    expect(testIconRegistry.size).toBe(0);
    unregister();
    expect(testIconRegistry.size).toBe(0);
  });
});
