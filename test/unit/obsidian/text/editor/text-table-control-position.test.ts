import { expect, it } from "vitest";
import { textTableControlPositions } from "../../../../../src/obsidian/text/editor/text-table-control-position";

it("keeps append targets outside the table and a continuous pointer path to its options", () => {
  const bounds = { left: 40, top: 80, right: 240, bottom: 180 };
  const { buttons } = textTableControlPositions(bounds, 500, 400);
  const [row, column, menu] = buttons;
  expect(row).toMatchObject({ left: 40, top: 180, width: 228, height: 28 });
  expect(column).toMatchObject({ left: 240, top: 80, width: 28, height: 100 });
  expect(menu.left + menu.width).toBe(bounds.right);
  expect(menu.top + menu.height).toBeGreaterThanOrEqual(bounds.top);
  expect(menu.top + menu.height).toBeLessThanOrEqual(bounds.top + 1.1);
});

it("keeps append rails inside the field and following text while retaining full touch targets", () => {
  const bounds = { left: 40, top: 80, right: 240, bottom: 180 };
  const field = { left: 32, top: 72, right: 248, bottom: 188 };
  const { buttons } = textTableControlPositions(bounds, 500, 400, field);
  expect(buttons[0].top).toBe(bounds.bottom);
  expect(buttons[1].left).toBe(bounds.right);
  expect(buttons[0]["--inkbook-table-rail-height"]).toBe(8);
  expect(buttons[1]["--inkbook-table-rail-width"]).toBe(8);
  expect(buttons[0].width).toBe(bounds.right - bounds.left + 28);
  expect(buttons[1].height).toBe(bounds.bottom - bounds.top);
  expect(buttons[2].left + buttons[2].width).toBe(bounds.right);
  const roomyField = { ...field, right: bounds.right + 16, bottom: bounds.bottom + 28 };
  const roomy = textTableControlPositions(bounds, 500, 400, roomyField);
  expect(roomy.buttons[0].top).toBe(bounds.bottom);
  expect(roomy.buttons[1].left).toBe(bounds.right);
  const closeText = textTableControlPositions(bounds, 500, 400, roomyField, bounds.bottom + 12);
  expect(closeText.buttons[0].top).toBe(bounds.bottom);
  expect(closeText.buttons[0]["--inkbook-table-rail-height"]).toBe(12);
  expect(closeText.buttons[0]["clip-path"]).toBe(
    "polygon(0 0, 100% 0, 100% 100%, 200px 100%, 200px 12px, 0 12px)",
  );
});

it("separates a narrow-padding phone table plus from the field grip while retaining its full rail", () => {
  const bounds = { left: 40, top: 80, right: 240, bottom: 180 };
  const field = { left: 33, top: 73, right: 247, bottom: 187 };
  const column = textTableControlPositions(bounds, 360, 800, field).buttons[1];
  expect(column["--inkbook-table-glyph-offset-y"]).toBe(-16);
  expect(column).toMatchObject({ left: 240, top: 80, width: 28, height: 100 });
  const glyphX = column.left + column["--inkbook-table-rail-width"] / 2;
  const glyphY =
    column.top +
    column["--inkbook-table-rail-height"] / 2 +
    column["--inkbook-table-glyph-offset-y"];
  expect(Math.hypot(glyphX - field.right, glyphY - (field.top + field.bottom) / 2)).toBeGreaterThan(
    12,
  );
  expect(glyphY).toBeGreaterThan(column.top);
  expect(glyphY).toBeLessThan(column.top + column.height);
  const clearField = { ...field, bottom: 260 };
  expect(
    textTableControlPositions(bounds, 360, 800, clearField).buttons[1][
      "--inkbook-table-glyph-offset-y"
    ],
  ).toBe(0);
});

it("separates the append-row plus from the bottom middle grip", () => {
  const field = { left: 0, top: 0, right: 100, bottom: 100 };
  const bounds = { left: 10, top: 10, right: 90, bottom: 90 };
  const row = textTableControlPositions(bounds, 360, 800, field).buttons[0];
  expect(row["--inkbook-table-glyph-offset-x"]).toBe(-16);
  expect(row).toMatchObject({ left: 10, top: 90, width: 108, height: 28 });
  const glyphX =
    row.left + row["--inkbook-table-rail-width"] / 2 + row["--inkbook-table-glyph-offset-x"];
  const glyphY = row.top + row["--inkbook-table-rail-height"] / 2;
  expect(Math.hypot(glyphX - 50, glyphY - field.bottom)).toBeGreaterThan(12);
});

it("uses a free interval between field grips for a tiny phone table glyph", () => {
  const field = { left: 0, top: 0, right: 200, bottom: 33 };
  const bounds = { left: 4.5, top: 4.5, right: 195.5, bottom: 18.5 };
  const column = textTableControlPositions(bounds, 360, 800, field).buttons[1];
  const glyphX = column.left + column["--inkbook-table-rail-width"] / 2;
  const glyphY =
    column.top +
    column["--inkbook-table-rail-height"] / 2 +
    column["--inkbook-table-glyph-offset-y"];
  expect(glyphY).toBe(8.25);
  expect(column["--inkbook-table-rail-width"]).toBe(4.5);
  for (const y of [field.top, field.bottom / 2, field.bottom])
    expect(Math.hypot(glyphX - field.right, glyphY - y)).toBeGreaterThan(6 + 4.5 / 2);
  expect(glyphY).toBeGreaterThan(column.top);
  expect(glyphY).toBeLessThan(column.top + column.height);
});

it.each([0.5, 1, 2])(
  "contains the visible rail at zoom %s without changing touch target size",
  (zoom) => {
    const bounds = { left: 40 * zoom, top: 80 * zoom, right: 240 * zoom, bottom: 180 * zoom };
    const field = { left: 12 * zoom, top: 52 * zoom, right: 268 * zoom, bottom: 208 * zoom };
    const { buttons } = textTableControlPositions(bounds, 1000, 1000, field);
    for (const button of [buttons[0], buttons[1]]) {
      const visualLeft = button.left + button["--inkbook-table-rail-left"];
      const visualTop = button.top + button["--inkbook-table-rail-top"];
      expect(visualLeft).toBeGreaterThanOrEqual(field.left);
      expect(visualTop).toBeGreaterThanOrEqual(field.top);
      expect(visualLeft + button["--inkbook-table-rail-width"]).toBeLessThanOrEqual(field.right);
      expect(visualTop + button["--inkbook-table-rail-height"]).toBeLessThanOrEqual(field.bottom);
      expect(button.width).toBeGreaterThanOrEqual(28);
      expect(button.height).toBeGreaterThanOrEqual(28);
    }
  },
);

it("retains reachable targets for tiny tables and clamps clipped tables without shared rail hits", () => {
  for (const bounds of [
    { left: 40, top: 80, right: 45, bottom: 85 },
    { left: -30, top: -50, right: 800, bottom: 900 },
  ]) {
    const { visible, buttons } = textTableControlPositions(bounds, 360, 800);
    expect(visible).toBe(true);
    for (const button of buttons) {
      expect(button.width).toBeGreaterThanOrEqual(28);
      expect(button.height).toBeGreaterThanOrEqual(28);
      expect(button.left).toBeGreaterThanOrEqual(0);
      expect(button.top).toBeGreaterThanOrEqual(0);
      expect(button.left + button.width).toBeLessThanOrEqual(360);
      expect(button.top + button.height).toBeLessThanOrEqual(800);
    }
    const [row, column, menu] = buttons;
    expect(row.top >= column.top + column.height || row.left + row.width <= column.left).toBe(true);
    if (menu.left < column.left + column.width && menu.left + menu.width > column.left)
      expect(column.top).toBeGreaterThanOrEqual(menu.top + menu.height);
  }
  expect(
    textTableControlPositions({ left: 400, top: 0, right: 500, bottom: 50 }, 360, 800).visible,
  ).toBe(false);
  expect(
    textTableControlPositions({ left: 0, top: 0, right: 10, bottom: 10 }, 20, 20).visible,
  ).toBe(false);
});
