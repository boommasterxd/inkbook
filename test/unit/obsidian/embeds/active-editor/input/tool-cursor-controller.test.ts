import { describe, expect, it } from "vitest";
import { createInputState, reduceInput } from "../../../../../../src/editor/input";
import { pointerDown } from "../../../../../fixtures/editor/input-actions";
import {
  cursorPointerEvent as event,
  toolCursorHarness as harness,
} from "../../../../../fixtures/obsidian/tool-cursor";

const empty = { cursor: null, system: "default" };

describe("active tool cursor input boundary", () => {
  it.each(["mouse", "pen"])(
    "defers %s hover geometry until the frame and reuses measured bounds",
    (pointerType) => {
      const h = harness();
      for (let x = 100; x <= 200; x += 1)
        h.controller.record(event({ clientX: x, pointerType }), "move");
      expect(h.measure).not.toHaveBeenCalled();
      expect(h.controller.lastPagePointer).toBeNull();
      expect(h.move).not.toHaveBeenCalled();
      expect(h.read().cursor).toMatchObject({ kind: "tool", x: 200, y: 80 });
      expect(h.measure).toHaveBeenCalledOnce();
      h.icon.mockClear();
      h.controller.record(event({ clientX: 201, pointerType }), "move");
      expect(h.move).toHaveBeenCalledExactlyOnceWith(201, 80);
      expect(h.icon).not.toHaveBeenCalled();
      expect(h.measure).toHaveBeenCalledOnce();
      expect(h.read().cursor?.x).toBe(201);
      expect(h.measure).toHaveBeenCalledOnce();
      h.controller.dispose();
    },
  );

  it("reprojects a stationary pointer after scroll, zoom, and camera changes", () => {
    const h = harness();
    h.controller.record(event(), "move");
    h.read();
    h.bounds.top = 10;
    h.controls.input = createInputState({ zoom: 2 });
    h.controls.cameraX = 5;
    h.controller.refresh();
    expect(h.read(true).cursor).toMatchObject({ x: 120, y: 80, icon: h.toolIcon });
    expect(h.controller.lastPagePointer).toMatchObject({ x: 45, y: 35 });
    expect(h.handleCursor).toHaveBeenLastCalledWith(expect.objectContaining({ x: 45, y: 35 }));
    expect(h.controller.lastScreenPointer).toMatchObject({ x: 100, y: 70 });
    expect(h.measure).toHaveBeenCalledTimes(2);
    h.controller.dispose();
  });

  it("keeps the same colored tool icon through drawing and commit without hover movement", () => {
    const h = harness();
    h.controls.input = createInputState({ activeTool: "highlighter" });
    h.controller.record(event(), "move");
    const cursor = h.read().cursor;
    expect(cursor).toMatchObject({
      kind: "tool",
      x: 120,
      y: 80,
      color: h.defaults.highlighter.color,
      icon: h.toolIcon,
    });
    expect(cursor).toHaveProperty("opacity", h.defaults.highlighter.opacity);
    expect(cursor).not.toHaveProperty("radius");
    h.controls.input = reduceInput(h.controls.input, pointerDown()).state;
    h.controller.record(event({ buttons: 1 }), "down");
    expect(h.read()).toEqual({ cursor, system: "crosshair" });
    h.controller.record(event(), "up");
    h.controls.input = reduceInput(h.controls.input, { type: "pointer-up", pointerId: 1 }).state;
    h.controller.refresh();
    expect(h.read()).toEqual({ cursor, system: "crosshair" });
    h.controller.record(event(), "move");
    expect(h.read().cursor).toEqual(cursor);
    expect(h.measure).toHaveBeenCalledOnce();
    expect(h.icon).toHaveBeenLastCalledWith("highlighter", h.defaults);
    h.controller.dispose();
  });

  it("prioritizes selection handles and stationary modifier changes", () => {
    const h = harness();
    h.controls.hint = "nwse-resize";
    h.controller.record(event(), "move");
    expect(h.read()).toMatchObject({ cursor: null, system: "nwse-resize" });
    h.document.dispatchEvent(
      Object.assign(new Event("keydown"), { ctrlKey: true, metaKey: false }),
    );
    expect(h.read().cursor).toMatchObject({ kind: "eraser", radius: h.defaults.eraser.radius });
    h.document.dispatchEvent(Object.assign(new Event("keyup"), { ctrlKey: false, metaKey: false }));
    expect(h.read().system).toBe("nwse-resize");
    h.controller.dispose();
  });
});

describe("active tool cursor pointer arbitration", () => {
  it("hides touch hover and pinch feedback while preserving the active touch eraser", () => {
    const h = harness();
    h.controls.input = createInputState({
      activeTool: "eraser",
      deviceFingerDrawingEnabled: true,
      toolbarFingerDrawingEnabled: true,
    });
    const touch = event({ pointerType: "touch" });
    h.controller.record(touch, "move");
    expect(h.read().cursor).toBeNull();
    h.controls.input = reduceInput(h.controls.input, pointerDown({ pointerType: "touch" })).state;
    h.controller.record(touch, "down");
    expect(h.read().cursor?.kind).toBe("eraser");
    h.controls.input = reduceInput(
      h.controls.input,
      pointerDown({ pointerType: "touch", pointerId: 2 }),
    ).state;
    h.controller.record(event({ pointerType: "touch", pointerId: 2 }), "down");
    expect(h.read().cursor).toBeNull();
    h.controller.record(event({ pointerType: "touch", pointerId: 2 }), "up");
    expect(h.read()).toEqual(empty);
    h.controller.dispose();
  });

  it("retains the pen handle cursor when a foreign palm moves and leaves", () => {
    const h = harness();
    h.controls.hint = "nwse-resize";
    h.controls.handlePointer = 1;
    h.controller.record(event({ pointerType: "pen" }), "down");
    expect(h.read().system).toBe("nwse-resize");
    h.controller.record(event({ pointerType: "touch", pointerId: 2, clientX: 200 }), "down");
    h.controller.record(event({ pointerType: "touch", pointerId: 2, clientX: 220 }), "move");
    h.surface.dispatchEvent(Object.assign(new Event("pointerleave"), { pointerId: 2 }));
    expect(h.read().system).toBe("nwse-resize");
    expect(h.controller.lastScreenPointer).toMatchObject({
      pointerId: 1,
      pointerType: "pen",
      x: 100,
    });
    h.controller.record(event({ pointerType: "pen", clientX: 130 }), "move");
    h.read();
    expect(h.controller.lastScreenPointer?.x).toBe(110);
    h.controls.handlePointer = undefined;
    h.controller.record(event({ pointerType: "touch", pointerId: 2 }), "move");
    expect(h.read()).toMatchObject({ cursor: null, system: "default" });
    h.controller.dispose();
  });

  it("ignores other pointers during an owned gesture and rejects invalid coordinates", () => {
    const h = harness();
    h.controls.input = reduceInput(createInputState({ activeTool: "eraser" }), pointerDown()).state;
    h.controller.record(event(), "down");
    expect(h.read().cursor?.x).toBe(120);
    h.controller.record(event({ pointerId: 2, clientX: 200 }), "move");
    expect(h.read().cursor?.x).toBe(120);
    h.controller.record(event({ clientX: Number.NaN }), "move");
    expect(h.read()).toEqual(empty);
    h.controller.dispose();
  });
});

describe("active tool cursor lifecycle", () => {
  it.each(["leave", "blur", "hidden", "cancel"])(
    "clears %s feedback and resumes on a fresh hover",
    (reason) => {
      const h = harness();
      h.surface.dispatchEvent(event());
      expect(h.read().cursor?.kind).toBe("tool");
      if (reason === "leave")
        h.surface.dispatchEvent(Object.assign(new Event("pointerleave"), { pointerId: 1 }));
      if (reason === "blur") h.window.dispatchEvent(new Event("blur"));
      if (reason === "hidden") {
        h.document.hidden = true;
        h.document.dispatchEvent(new Event("visibilitychange"));
      }
      if (reason === "cancel") h.controller.clear(1);
      expect(h.read()).toEqual(empty);
      h.document.hidden = false;
      h.surface.dispatchEvent(event());
      expect(h.read().cursor?.kind).toBe("tool");
      h.controller.dispose();
    },
  );

  it("suppresses menus, disabled editors, and out-of-surface pointers without measuring hidden feedback", () => {
    const h = harness();
    h.controller.record(event(), "move");
    h.controls.menuOpen = true;
    expect(h.read()).toEqual(empty);
    expect(h.measure).not.toHaveBeenCalled();
    h.controls.menuOpen = false;
    h.controls.enabled = false;
    h.controller.record(event({ clientX: 200 }), "move");
    expect(h.read()).toEqual(empty);
    h.controls.enabled = true;
    expect(h.read().cursor?.x).toBe(120);
    h.controller.record(event({ clientX: 0 }), "move");
    expect(h.read()).toEqual(empty);
    h.controller.dispose();
  });

  it("does not clear another pointer and removes owned listeners on idempotent disposal", () => {
    const h = harness();
    h.controller.record(event(), "move");
    h.controller.clear(2);
    expect(h.read().cursor?.kind).toBe("tool");
    h.controller.dispose();
    expect(h.read()).toEqual(empty);
    h.request.mockClear();
    h.controller.dispose();
    h.surface.dispatchEvent(event());
    h.window.dispatchEvent(new Event("blur"));
    h.document.dispatchEvent(Object.assign(new Event("keydown"), { ctrlKey: true }));
    h.controller.record(event(), "move");
    h.controller.refresh();
    expect(h.request).not.toHaveBeenCalled();
  });
});

describe("Wayland pen proximity exit reported with a mouse ID", () => {
  it.each(["draw", "eraser"] as const)(
    "clears idle %s feedback and resumes on fresh pen input",
    (activeTool) => {
      const h = harness();
      h.controls.input = createInputState({ activeTool });
      h.surface.dispatchEvent(event({ pointerId: 2, pointerType: "pen" }));
      expect(h.read().cursor).not.toBeNull();
      h.measure.mockClear();
      h.surface.dispatchEvent(
        Object.assign(new Event("pointerleave"), {
          pointerId: 1,
          pointerType: "mouse",
          buttons: 0,
          relatedTarget: null,
        }),
      );
      expect(h.read()).toEqual(empty);
      h.controller.refresh();
      expect(h.read()).toEqual(empty);
      expect(h.measure).not.toHaveBeenCalled();
      h.controller.record(event({ pointerId: 2, pointerType: "pen" }), "move");
      expect(h.read().cursor).not.toBeNull();
      h.controller.dispose();
    },
  );

  it.each(["touch", "other-pen", "internal", "pressed", "gesture", "handle", "mouse"])(
    "does not treat %s departure as idle pen proximity loss",
    (reason) => {
      const h = harness();
      h.controller.record(
        event({ pointerId: 2, pointerType: reason === "mouse" ? "mouse" : "pen" }),
        "move",
      );
      if (reason === "gesture")
        h.controls.input = reduceInput(
          h.controls.input,
          pointerDown({ pointerId: 2, pointerType: "pen" }),
        ).state;
      if (reason === "handle") h.controls.handlePointer = 2;
      const before = h.read();
      h.surface.dispatchEvent(
        Object.assign(new Event("pointerleave"), {
          pointerId: 1,
          pointerType: reason === "touch" ? "touch" : reason === "other-pen" ? "pen" : "mouse",
          buttons: reason === "pressed" ? 1 : 0,
          relatedTarget: reason === "internal" ? h.surface : null,
        }),
      );
      expect(h.read()).toEqual(before);
      h.controller.dispose();
    },
  );
});

it.each(["outside", "menu", "pointer", "type", "eraser-button", "modifier", "cleared"])(
  "defers position-only movement after %s changes",
  (change) => {
    const h = harness();
    h.controller.record(event(), "move");
    h.read();
    h.measure.mockClear();
    h.icon.mockClear();
    if (change === "menu") h.controls.menuOpen = true;
    if (change === "cleared") h.controller.clear();
    h.controller.record(
      event({
        clientX: change === "outside" ? -1 : 150,
        pointerId: change === "pointer" ? 2 : 1,
        pointerType: change === "type" || change === "eraser-button" ? "pen" : "mouse",
        buttons: change === "eraser-button" ? 32 : 0,
        ctrlKey: change === "modifier",
      }),
      "move",
    );
    expect(h.move).not.toHaveBeenCalled();
    expect(h.measure).not.toHaveBeenCalled();
    expect(h.icon).not.toHaveBeenCalled();
    h.controller.dispose();
  },
);
