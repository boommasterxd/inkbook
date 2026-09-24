// @vitest-environment happy-dom
import { expect, it } from "vitest";

import { recordPenEvent } from "../../../../src/obsidian/diagnostics/pen-event-record";

function keyboard(type: string, key: string, code: string, keyCode: number) {
  const event = new KeyboardEvent(type, {
    key,
    code,
    location: 2,
    repeat: true,
    isComposing: false,
    ctrlKey: true,
    shiftKey: true,
    bubbles: true,
    cancelable: true,
  });
  Object.defineProperties(event, {
    keyCode: { value: keyCode },
    which: { value: keyCode },
    charCode: { value: 97 },
  });
  return event;
}

it.each([
  ["Unidentified", "", 0],
  ["ContextMenu", "ContextMenu", 93],
  ["Unidentified", "Unidentified", 308],
  ["F24", "F24", 135],
  ["StylusButtonPrimary", "StylusButtonPrimary", 0],
  ["Control", "ControlLeft", 17],
])(
  "preserves paired control events for %s / %s without interpreting native codes",
  (key, code, value) => {
    for (const type of ["keydown", "keyup"]) {
      const record = recordPenEvent(keyboard(type, key, code, value), 3, 42);
      expect(record).toMatchObject({
        type,
        windowId: 3,
        relativeTimeMs: 42,
        key,
        code,
        keyCode: value,
        which: value,
        location: 2,
        repeat: true,
        isComposing: false,
        ctrlKey: true,
        shiftKey: true,
        cancelable: true,
        defaultPrevented: false,
      });
      expect(record).not.toHaveProperty("charCode");
    }
  },
);

it.each([
  ["a", "KeyA"],
  ["1", "Digit1"],
  [" ", "Space"],
  ["private-note", "private-path"],
  ["Dead", "KeyE"],
  ["Process", "Unidentified"],
  ["Unidentified", "KeyA"],
  ["a", "Unidentified"],
  ["F25", "F25"],
])("redacts non-allowlisted key material and legacy character codes: %s / %s", (key, code) => {
  const record = recordPenEvent(keyboard("keydown", key, code, 97), 1, 0);
  expect(record["key"]).toBe(key === "Unidentified" ? key : "[redacted]");
  expect(record["code"]).toBe(code === "Unidentified" ? code : "[redacted]");
  expect(record).not.toHaveProperty("keyCode");
  expect(record).not.toHaveProperty("which");
  expect(record).not.toHaveProperty("charCode");
});

it("omits nonfinite legacy codes and leaves non-keyboard events without keyboard fields", () => {
  const event = keyboard("keyup", "Unidentified", "", Infinity);
  const record = recordPenEvent(event, 1, 0);
  expect(record).not.toHaveProperty("keyCode");
  expect(record).not.toHaveProperty("which");
  expect(recordPenEvent(new Event("blur"), 1, 0)).not.toHaveProperty("key");
});

it("withholds legacy codes during composition even for unidentified keys", () => {
  const event = keyboard("keydown", "Unidentified", "", 229);
  Object.defineProperty(event, "isComposing", { value: true });
  const record = recordPenEvent(event, 1, 0);
  expect(record).toMatchObject({ key: "Unidentified", code: "", isComposing: true });
  expect(record).not.toHaveProperty("keyCode");
  expect(record).not.toHaveProperty("which");
});
