export interface TableControlBounds {
  readonly left: number;
  readonly top: number;
  readonly right: number;
  readonly bottom: number;
}

/** Chrome uses iframe viewport pixels, independently of the document's SVG zoom. */
export function textTableControlPositions(
  bounds: TableControlBounds,
  width: number,
  height: number,
  fieldBounds?: TableControlBounds,
  followingTop?: number,
) {
  const size = 28;
  const field = fieldBounds ?? { left: 0, top: 0, right: width, bottom: height };
  const clampX = (value: number) => Math.max(0, Math.min(width - size, value));
  const clampY = (value: number) => Math.max(0, Math.min(height - size, value));
  const left = clampX(bounds.left);
  // Overlap the table border by one pixel so fractional CSS rounding cannot reopen the gap.
  const menuHeight = Math.min(size + 5, height);
  const menu = {
    left: clampX(bounds.right - size),
    top: Math.max(0, Math.min(height - menuHeight, bounds.top - size - 4)),
    width: size,
    height: menuHeight,
    "padding-bottom": 5,
  };
  const right = clampX(bounds.right);
  const menuOverlapsRight = menu.left < right + size && menu.left + size > right;
  const top = clampY(Math.max(bounds.top, menuOverlapsRight ? menu.top + menu.height : 0));
  const bottom = clampY(Math.max(bounds.bottom, top + size));
  const rail = (button: TableControlBounds, visual: TableControlBounds, axis: "x" | "y") => ({
    left: button.left,
    top: button.top,
    width: button.right - button.left,
    height: button.bottom - button.top,
    "--inkbook-table-rail-left": visual.left - button.left,
    "--inkbook-table-rail-top": visual.top - button.top,
    "--inkbook-table-rail-width": Math.max(0, visual.right - visual.left),
    "--inkbook-table-rail-height": Math.max(0, visual.bottom - visual.top),
    "--inkbook-table-glyph-offset-x": axis === "x" ? glyphOffset(button, visual, field, axis) : 0,
    "--inkbook-table-glyph-offset-y": axis === "y" ? glyphOffset(button, visual, field, axis) : 0,
  });
  const rowRight = left + Math.max(size, Math.min(bounds.right, right) - left);
  const rowTargetRight = Math.min(width, Math.max(rowRight, right + size));
  const gap = Math.max(0, Math.min(size, (followingTop ?? bottom + size) - bottom));
  const corner = Math.max(0, bounds.right - left);
  const columnBottom = top + Math.max(size, Math.min(bottom, bounds.bottom) - top);
  return {
    visible:
      width >= size &&
      height >= size &&
      bounds.right > 0 &&
      bounds.bottom > 0 &&
      bounds.left < width &&
      bounds.top < height,
    buttons: [
      {
        ...rail(
          { left, top: bottom, right: rowTargetRight, bottom: bottom + size },
          {
            left: Math.max(left, field.left),
            top: bottom,
            right: Math.min(rowRight, field.right),
            bottom: Math.min(bottom + 16, field.bottom, followingTop ?? height),
          },
          "x",
        ),
        "clip-path": `polygon(0 0, 100% 0, 100% 100%, ${corner}px 100%, ${corner}px ${gap}px, 0 ${gap}px)`,
      },
      rail(
        { left: right, top, right: right + size, bottom: columnBottom },
        {
          left: right,
          top: Math.max(top, field.top),
          right: Math.min(right + 16, field.right),
          bottom: Math.min(columnBottom, field.bottom),
        },
        "y",
      ),
      menu,
    ] as const,
  };
}

/** Keep the glyph separately actionable when a narrow zoomed padding meets a field grip. */
function glyphOffset(
  button: TableControlBounds,
  visual: TableControlBounds,
  field: TableControlBounds,
  axis: "x" | "y",
): number {
  const center = { x: (visual.left + visual.right) / 2, y: (visual.top + visual.bottom) / 2 };
  const middle = { x: (field.left + field.right) / 2, y: (field.top + field.bottom) / 2 };
  const grips = [field.left, middle.x, field.right].flatMap((x) =>
    [field.top, middle.y, field.bottom]
      .filter((y) => x !== middle.x || y !== middle.y)
      .map((y) => ({ x, y })),
  );
  const glyphSize = Math.max(
    0,
    Math.min(12, visual.right - visual.left, visual.bottom - visual.top),
  );
  const clearance = 6 + glyphSize / 2;
  const clear = (offset: number) =>
    grips.every(
      (grip) =>
        Math.hypot(
          center.x + (axis === "x" ? offset : 0) - grip.x,
          center.y + (axis === "y" ? offset : 0) - grip.y,
        ) >= clearance,
    );
  if (clear(0)) return 0;
  const lower = axis === "x" ? button.left : button.top;
  const upper = axis === "x" ? button.right : button.bottom;
  const positions =
    axis === "x" ? [field.left, middle.x, field.right] : [field.top, middle.y, field.bottom];
  const candidates = [
    -16,
    16,
    (positions[0]! + positions[1]!) / 2 - center[axis],
    (positions[1]! + positions[2]!) / 2 - center[axis],
  ];
  for (const direction of candidates) {
    const offset =
      Math.max(lower + 1, Math.min(upper - 1, center[axis] + direction)) - center[axis];
    if (clear(offset)) return offset;
  }
  return 0;
}
