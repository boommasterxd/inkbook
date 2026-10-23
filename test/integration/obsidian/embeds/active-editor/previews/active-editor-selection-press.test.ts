import { describe, expect, it } from "vitest";
import { createInputState } from "../../../../../../src/editor/input";
import { indexedStroke } from "../../../../../fixtures/editor/stroke";
import { effectTypes } from "../../../../../fixtures/editor/input-actions";
import { activeEditorPointerHarness as harness } from "../../../../../fixtures/obsidian/active-editor-pointer";
import { timedCursorPointerEvent as sample } from "../../../../../fixtures/obsidian/tool-cursor";
import { rectangle } from "../../../../../unit/domain/store/fixtures";

function selectHarness(elements: Parameters<typeof harness>[0] = [], hasSelection = false) {
  const h = harness(elements);
  h.controls.input = createInputState({ activeTool: "select", hasSelection });
  return h;
}

function contactFields(pointerType = "mouse", overrides: Partial<PointerEvent> = {}) {
  return {
    pointerType,
    buttons: 1,
    button: 0,
    pressure: 0.5,
    clientX: 40,
    clientY: 50,
    ...overrides,
  };
}

describe("active Select press arbitration", () => {
  it.each(["mouse", "pen"] as const)(
    "starts an area over an unselected stroke using %s without hit testing",
    (pointerType) => {
      const h = selectHarness([indexedStroke(0)]);
      const contact = contactFields(pointerType);
      try {
        h.pointer.handlePointerDown(sample(10, contact));
        h.pointer.handlePointerMove(sample(20, { ...contact, clientX: 47 }));
        h.pointer.handlePointerUp(sample(30, { ...contact, clientX: 60 }));
        expect(h.hit).not.toHaveBeenCalled();
        expect(effectTypes(h.effects)).toEqual([
          "capture-pointer",
          ...(pointerType === "pen" ? ["schedule-long-press", "cancel-long-press"] : []),
          "begin-preview",
          "update-preview",
          "update-preview",
          "commit-preview",
          "release-pointer",
        ]);
        expect(h.capture).toHaveBeenCalledExactlyOnceWith(1);
        expect(h.release).toHaveBeenCalledExactlyOnceWith(1);
      } finally {
        h.controller.dispose();
      }
    },
  );

  it("hit tests a mouse click at its initial point after release coordinates are admitted", () => {
    const element = indexedStroke(0);
    const h = selectHarness([element]);
    const contact = contactFields("mouse", { pressure: 0 });
    try {
      h.pointer.handlePointerDown(sample(10, contact));
      expect(h.hit).not.toHaveBeenCalled();
      h.pointer.handlePointerUp(sample(20, { ...contact, buttons: 0, clientX: 45 }));
      expect(h.hit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ x: 20, y: 20 }),
        "mouse",
        1,
      );
      expect(h.effects).toContainEqual({
        type: "select-element",
        elementId: element.id,
        mode: "replace",
      });
      expect(h.controls.input.interaction).toBeUndefined();
    } finally {
      h.controller.dispose();
    }
  });
});

describe("coalesced Select press arbitration", () => {
  it.each([
    ["mouse", true, "release"],
    ["pen", true, "release"],
    ["mouse", true, "cancel"],
    ["pen", true, "cancel"],
    ["mouse", false, "release"],
    ["pen", false, "release"],
  ] as const)(
    "keeps %s batch excursion=%s authoritative through %s",
    (pointerType, excursion, terminal) => {
      const element = indexedStroke(0);
      const h = selectHarness([element]);
      const contact = contactFields(pointerType);
      const batch = [sample(20, { ...contact, clientX: excursion ? 47 : 46 }), sample(30, contact)];
      try {
        h.pointer.handlePointerDown(sample(10, contact));
        expect(h.effects.filter((effect) => effect.type === "schedule-long-press")).toHaveLength(
          pointerType === "pen" ? 1 : 0,
        );
        h.pointer.handlePointerMove(sample(30, { ...contact, getCoalescedEvents: () => batch }));
        expect(h.controls.input.interaction?.phase).toBe(excursion ? "lasso" : "select-pending");
        expect(
          h.dispatch.mock.calls.filter(([action]) => action.type === "pointer-move"),
        ).toHaveLength(1);
        expect(h.effects.filter((effect) => effect.type === "begin-preview")).toHaveLength(
          excursion ? 1 : 0,
        );
        expect(h.effects.filter((effect) => effect.type === "update-preview")).toHaveLength(
          excursion ? 1 : 0,
        );
        if (terminal === "cancel") h.pointer.handlePointerCancel(sample(40, contact));
        else h.pointer.handlePointerUp(sample(40, contact));
        expect(h.effects.some((effect) => effect.type === "select-element")).toBe(!excursion);
        expect(h.hit).toHaveBeenCalledTimes(excursion ? 0 : 1);
        expect(h.controls.input.interaction).toBeUndefined();
        expect(h.effects.some((effect) => effect.type === "revert-preview")).toBe(
          terminal === "cancel",
        );
        expect(h.effects.filter((effect) => effect.type === "cancel-long-press")).toHaveLength(
          pointerType === "pen" ? 1 : 0,
        );
      } finally {
        h.controller.dispose();
      }
    },
  );
});

describe("coalesced Select release arbitration", () => {
  it.each(["mouse", "pen"] as const)(
    "commits a %s area from final contact samples before release",
    (pointerType) => {
      const h = selectHarness([indexedStroke(0)]);
      const contact = contactFields(pointerType);
      const batch = [sample(20, { ...contact, clientX: 47 }), sample(30, contact)];
      try {
        h.pointer.handlePointerDown(sample(10, contact));
        h.pointer.handlePointerUp(
          sample(40, {
            ...contact,
            buttons: 0,
            pressure: 0,
            getCoalescedEvents: () => batch,
          }),
        );
        expect(effectTypes(h.effects)).toEqual([
          "capture-pointer",
          ...(pointerType === "pen" ? ["schedule-long-press", "cancel-long-press"] : []),
          "begin-preview",
          "update-preview",
          "commit-preview",
          "release-pointer",
        ]);
        expect(h.hit).not.toHaveBeenCalled();
        expect(h.controls.input.interaction).toBeUndefined();
      } finally {
        h.controller.dispose();
      }
    },
  );
});

describe("selected pen release contact ownership", () => {
  it.each([false, true])(
    "ignores selected-release hover jitter while retaining coalesced contact=%s",
    (realContact) => {
      const element = rectangle();
      const h = selectHarness([element], true);
      h.selection.add(element.id);
      const contact = contactFields("pen", {
        clientX: element.pivot.x + h.bounds.left,
        clientY: element.pivot.y + h.bounds.top,
      });
      try {
        h.pointer.handlePointerDown(sample(10, contact));
        expect(h.controls.input.interaction?.phase).toBe("element-move");
        h.pointer.handlePointerUp(
          sample(40, {
            ...contact,
            pressure: 0,
            buttons: 0,
            clientX: contact.clientX + 3,
            getCoalescedEvents: () =>
              realContact ? [sample(30, { ...contact, clientX: contact.clientX + 7 })] : [],
          }),
        );
        expect(effectTypes(h.effects)).toEqual(
          realContact
            ? [
                "capture-pointer",
                "schedule-long-press",
                "cancel-long-press",
                "begin-preview",
                "update-preview",
                "commit-preview",
                "release-pointer",
              ]
            : ["capture-pointer", "schedule-long-press", "cancel-long-press", "release-pointer"],
        );
        if (realContact)
          expect(h.effects.find((effect) => effect.type === "update-preview")).toMatchObject({
            kind: "element-move",
            pointer: { x: element.pivot.x + 7, y: element.pivot.y },
          });
        expect(h.hit).not.toHaveBeenCalled();
        expect(h.controls.input.interaction).toBeUndefined();
      } finally {
        h.controller.dispose();
      }
    },
  );

  it("keeps a won pen lasso at its final contact point on hover release", () => {
    const h = selectHarness();
    const contact = contactFields("pen");
    try {
      h.pointer.handlePointerDown(sample(10, contact));
      h.pointer.handlePointerMove(sample(20, { ...contact, clientX: 47 }));
      expect(h.controls.input.interaction?.phase).toBe("lasso");
      h.pointer.handlePointerUp(
        sample(30, { ...contact, pressure: 0, buttons: 0, clientX: 400, clientY: 500 }),
      );
      expect(effectTypes(h.effects)).toEqual([
        "capture-pointer",
        "schedule-long-press",
        "cancel-long-press",
        "begin-preview",
        "update-preview",
        "commit-preview",
        "release-pointer",
      ]);
      expect(h.effects.find((effect) => effect.type === "update-preview")).toMatchObject({
        kind: "lasso",
        pointer: { x: 27, y: 20 },
      });
      expect(h.controls.input.interaction).toBeUndefined();
    } finally {
      h.controller.dispose();
    }
  });
});

describe("active Select press terminal ownership", () => {
  it("ignores noncontact pen release positions before confirming a stationary tap", () => {
    const element = indexedStroke(0);
    const h = selectHarness([element]);
    const contact = contactFields("pen");
    try {
      h.pointer.handlePointerDown(sample(10, contact));
      h.pointer.handlePointerUp(
        sample(20, { ...contact, pressure: 0, buttons: 0, clientX: 300, clientY: 400 }),
      );
      expect(h.effects).toContainEqual({
        type: "select-element",
        elementId: element.id,
        mode: "replace",
      });
      expect(effectTypes(h.effects)).toEqual([
        "capture-pointer",
        "schedule-long-press",
        "select-element",
        "cancel-long-press",
        "release-pointer",
      ]);
      expect(h.hit).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ x: 20, y: 20 }),
        "pen",
        1,
      );
    } finally {
      h.controller.dispose();
    }
  });

  it.each(["cancel", "capture-loss"] as const)(
    "releases %s without hit testing or changing selection",
    (terminal) => {
      const h = selectHarness([indexedStroke(0)], true);
      const contact = contactFields("mouse", { pressure: 0 });
      try {
        h.pointer.handlePointerDown(sample(10, contact));
        if (terminal === "cancel") h.pointer.handlePointerCancel(sample(20, contact));
        else h.pointer.handleLostPointerCapture(sample(20, contact));
        expect(h.hit).not.toHaveBeenCalled();
        expect(effectTypes(h.effects)).toEqual(["capture-pointer", "release-pointer"]);
        expect(h.controls.input.hasSelection).toBe(true);
        expect(h.controls.input.interaction).toBeUndefined();
      } finally {
        h.controller.dispose();
      }
    },
  );
});
