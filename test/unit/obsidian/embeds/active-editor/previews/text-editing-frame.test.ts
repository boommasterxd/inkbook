import { expect, it } from "vitest";
import { calculateElementBounds } from "../../../../../../src/domain/geometry/public";
import { createSelectionFrameAtRotation } from "../../../../../../src/editor/selection/public";
import { TextEditingFrame } from "../../../../../../src/obsidian/embeds/active-editor/previews/text-editing-frame";
import { textElement } from "../../../../../fixtures/rendering/text";

it.each([0, 37])(
  "maps a retained native source height onto the prepared rectangle at %s degrees",
  (rotation) => {
    const native = textElement({ rotation, width: 200, height: 100 });
    const prepared = {
      ...native,
      x: 40,
      y: 50,
      width: 300,
      height: 150,
      pivot: { x: 190, y: 125 },
    };
    const selected = [{ element: prepared, bounds: calculateElementBounds(prepared) }];
    const editing = new TextEditingFrame();
    editing.set(native.id, 180, native);
    const expected = createSelectionFrameAtRotation([{ ...prepared, height: 270 }], rotation);
    expect(editing.preview(selected)).toEqual(expected);
    expect(editing.preview(selected)).toBe(editing.preview(selected));
    // The complete new native layout has the same source height but a different basis.
    expect(editing.set(prepared.id, 180, prepared)).toBe(true);
    expect(editing.preview(selected)).toEqual(
      createSelectionFrameAtRotation([{ ...prepared, height: 180 }], rotation),
    );
    expect(editing.set(prepared.id, 180, prepared)).toBe(false);
    editing.set(prepared.id, undefined);
    expect(editing.preview(selected)).toBeNull();
  },
);
