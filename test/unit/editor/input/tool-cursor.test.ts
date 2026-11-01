import { describe, expect, it } from "vitest";
import { createBuiltInSettings } from "../../../../src/domain/settings/defaults";
import { STARTUP_TOOLS } from "../../../../src/domain/settings/types";
import { createInputState, reduceInput } from "../../../../src/editor/input";
import {
  resolveToolCursor,
  type ToolCursorOptions,
  type ToolSystemCursor,
} from "../../../../src/editor/input/tool-cursor";
import { pointerDown, pointerMove } from "../../../fixtures/editor/input-actions";

const defaults = createBuiltInSettings().toolDefaults;
const pointer = { pointerId: 1, pointerType: "mouse" } as const;
const base: ToolCursorOptions = { state: createInputState(), defaults, pointer };
const normal = { system: "default", overlay: undefined };

function resolve(overrides: Partial<ToolCursorOptions> = {}) {
  return resolveToolCursor({ ...base, ...overrides });
}

describe("tool cursor policy", () => {
  it("uses each toolbar tool and its color for fixed-size feedback with configured paint", () => {
    const custom = createBuiltInSettings().toolDefaults;
    custom.pen.color = { type: "rgba", value: "#12345680" };
    custom.highlighter.color = { type: "rgba", value: "#23456780" };
    custom.straightHighlighter.color = { type: "rgba", value: "#34567880" };
    for (const shape of Object.values(custom.shapes)) {
      shape.outlineColor = { type: "rgba", value: "#45678980" };
    }
    for (const activeTool of STARTUP_TOOLS) {
      if (activeTool === "eraser") continue;
      const colors = {
        select: { type: "theme-text" },
        draw: custom.pen.color,
        highlighter: custom.highlighter.color,
        "straight-highlighter": custom.straightHighlighter.color,
      } as const;
      const color =
        activeTool in colors
          ? colors[activeTool as keyof typeof colors]
          : { type: "rgba", value: "#45678980" };
      const before = resolve({ state: createInputState({ activeTool }), defaults: custom });
      expect(before).toMatchObject({
        system: "crosshair",
        overlay: { kind: "tool", tool: activeTool, color },
      });
      expect(
        resolve({
          state: createInputState({ activeTool }),
          defaults: custom,
          pointer: { ...pointer, pointerType: "pen" },
        }),
      ).toEqual(before);
      for (const width of [2, 22] as const) {
        custom.pen.width = custom.highlighter.width = custom.straightHighlighter.width = width;

        for (const shape of Object.values(custom.shapes)) {
          shape.outlineWidth = width;

          shape.outlineStyle = "dotted";
        }
        for (const zoom of [0.25, 4]) {
          expect(
            resolve({ state: createInputState({ activeTool, zoom }), defaults: custom }),
          ).toEqual(before);
        }
      }
    }
  });

  it("uses independent outline and fill paint for closed shapes and drawing opacity", () => {
    const custom = createBuiltInSettings().toolDefaults;
    custom.shapes.rectangle.outlineOpacity = 0.3;
    custom.shapes.rectangle.fillColor = { type: "rgba", value: "#12345680" };
    custom.shapes.rectangle.fillOpacity = 0.6;
    expect(
      resolve({ state: createInputState({ activeTool: "rectangle" }), defaults: custom }).overlay,
    ).toMatchObject({
      color: custom.shapes.rectangle.outlineColor,
      opacity: 0.3,
      fillColor: custom.shapes.rectangle.fillColor,
      fillOpacity: 0.6,
    });
    custom.shapes.rectangle.fillColor = null;
    expect(
      resolve({ state: createInputState({ activeTool: "rectangle" }), defaults: custom }).overlay,
    ).toMatchObject({ fillColor: null });
    for (const [activeTool, style] of [
      ["draw", custom.pen],
      ["highlighter", custom.highlighter],
      ["straight-highlighter", custom.straightHighlighter],
    ] as const) {
      style.opacity = 0.23;
      expect(
        resolve({ state: createInputState({ activeTool }), defaults: custom }).overlay,
      ).toEqual({ kind: "tool", tool: activeTool, color: style.color, opacity: 0.23 });
    }
  });
});

describe("tool cursor erasing and hints", () => {
  it("uses the configured screen eraser radius regardless of zoom", () => {
    for (const radius of [8, 20, 64]) {
      for (const zoom of [0.25, 4]) {
        expect(
          resolve({
            state: createInputState({ activeTool: "eraser", zoom }),
            defaults: { ...defaults, eraser: { radius } },
          }),
        ).toEqual({ system: "crosshair", overlay: { kind: "eraser", radius } });
      }
    }
  });

  it("reserves temporary eraser hover before selection hints except in Select", () => {
    for (const temporary of [
      { pointerType: "mouse", controlOrMeta: true },
      { pointerType: "mouse", penRole: "eraser" },
      { pointerType: "pen", penRole: "eraser" },
      { pointerType: "pen", penRole: "side-button" },
    ] as const) {
      const activePointer = { ...pointer, ...temporary };
      expect(resolve({ pointer: activePointer, systemHint: "move" })).toEqual({
        system: "crosshair",
        overlay: { kind: "eraser", radius: 20 },
      });
      expect(
        resolve({ pointer: activePointer, state: createInputState({ activeTool: "select" }) })
          .overlay,
      ).toEqual({ kind: "tool", tool: "select", color: { type: "theme-text" }, opacity: 1 });
    }
    expect(
      resolve({ pointer: { ...pointer, pointerType: "pen", penRole: "normal" } }).overlay?.kind,
    ).toBe("tool");
    expect(resolve({ pointer: { ...pointer, penRole: "side-button" } }).overlay?.kind).toBe("tool");
  });

  it("accepts precise system hints without any tool overlay", () => {
    const hints: ToolSystemCursor[] = [
      "move",
      "grab",
      "grabbing",
      "ew-resize",
      "ns-resize",
      "nesw-resize",
      "nwse-resize",
    ];
    for (const systemHint of hints) {
      expect(resolve({ systemHint })).toEqual({ system: systemHint, overlay: undefined });
    }
  });
});

describe("tool cursor interactions", () => {
  it("keeps the accepted creation tool visible throughout contact", () => {
    for (const activeTool of STARTUP_TOOLS) {
      if (activeTool === "select" || activeTool === "eraser") continue;
      const initial = createInputState({ activeTool });
      const state = reduceInput(initial, pointerDown()).state;
      expect(resolve({ state: { ...state, activeTool: "select" }, systemHint: "move" })).toEqual(
        resolve({ state: initial }),
      );
    }
  });

  it("uses accepted gestures instead of the toolbar tool or stale hover hints", () => {
    const moved = reduceInput(
      base.state,
      pointerDown({ target: { elementId: "a", isSelected: true } }),
    ).state;
    expect(resolve({ state: moved })).toEqual({ system: "move", overlay: undefined });
    const erased = reduceInput(base.state, pointerDown({ controlOrMeta: true })).state;
    expect(resolve({ state: erased, systemHint: "move" }).overlay).toEqual({
      kind: "eraser",
      radius: 20,
    });
    const lasso = reduceInput(createInputState({ activeTool: "select" }), pointerDown()).state;
    expect(resolve({ state: lasso, systemHint: "grab" }).overlay).toEqual({
      kind: "tool",
      tool: "select",
      color: { type: "theme-text" },
      opacity: 1,
    });
    expect(resolve({ state: erased, pointer: { ...pointer, pointerId: 2 } })).toEqual(normal);
  });

  it("suppresses touch hover and pending navigation but shows accepted touch erasing", () => {
    const touch = { ...pointer, pointerType: "touch" } as const;
    expect(resolve({ pointer: touch })).toEqual(normal);
    const pending = reduceInput(base.state, pointerDown(touch)).state;
    expect(resolve({ state: pending, pointer: touch })).toEqual(normal);
    for (const position of [
      { x: 100, y: 0 },
      { x: 0, y: 100 },
    ]) {
      const state = reduceInput(pending, pointerMove({ ...touch, ...position })).state;
      expect(resolve({ state, pointer: touch })).toEqual({
        system: "grabbing",
        overlay: undefined,
      });
    }
    const state = reduceInput(
      createInputState({
        activeTool: "eraser",
        deviceFingerDrawingEnabled: true,
        toolbarFingerDrawingEnabled: true,
      }),
      pointerDown(touch),
    ).state;
    expect(resolve({ state, pointer: touch })).toEqual({
      system: "default",
      overlay: { kind: "eraser", radius: 20 },
    });
    const pinch = reduceInput(pending, pointerDown({ ...touch, pointerId: 2 })).state;
    expect(resolve({ state: pinch, pointer: touch })).toEqual(normal);
    const drawing = reduceInput(
      createInputState({ deviceFingerDrawingEnabled: true, toolbarFingerDrawingEnabled: true }),
      pointerDown(touch),
    ).state;
    expect(resolve({ state: drawing, pointer: touch })).toEqual(normal);
  });

  it("restores native feedback for absent pointers and blocked surfaces", () => {
    expect(resolve({ pointer: undefined })).toEqual(normal);
    expect(resolve({ suppressed: true, systemHint: "grabbing" })).toEqual(normal);
  });
});
