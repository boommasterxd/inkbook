import { describe, expect, it } from "vitest";
import { validatePathDataSteps } from "../../../../src/persistence/documents/path-data-validator";

function validate(path: string, bytesPerStep = 1) {
  const steps = validatePathDataSteps(path, { bytesPerStep, commandsPerStep: 1 });
  let step = steps.next();
  while (!step.done) step = steps.next();
  return step.value;
}

describe("bounded relative pressure path commands", () => {
  it.each([
    "M0 0q.1-.2.3-.4a.5.6 0 0 1-.1.2",
    "M999999.999 0q.001 0 .001 0",
    "M-999999.999 0q-.001 0-.001 0",
    "M10 20q1 2 3 4a2 3 0 0 1-1-2Z",
    "M999999.999-999999.999q0.001-0.001 0.001-0.001",
    "M1000000-1000000q-1000000 1000000-1000000 1000000",
    "M999999.998 0q0.001 0 0.001 0q0.001 0 0.001 0",
    "M-999999.998 0q-0.001 0-0.001 0q-0.001 0-0.001 0",
    "M999999.999 0a1 1 0 1 0 0.001 0",
    "M100 100q0 0 1 1M999999.999 0q0.001 0 0.001 0",
    "M100 100q0 0 1 1ZM999999.999 0q0.001 0 0.001 0",
    "M0 0L999999.999 0a1 1 0 0 1 0.001 0",
    "M0 0Q1 2 999999.999 0q0.001 0 0.001 0",
    "M0 0C1 2 3 4 999999.999 0q0.001 0 0.001 0",
    "M0 0A1 1 0 0 1 999999.999 0q0.001 0 0.001 0",
  ])("accepts exact derived coordinates across one-byte slices: %s", (path) => {
    expect(validate(path)).not.toBeNull();
  });

  it.each([
    "M.1 0",
    "M0 0Q.1 0 0 0",
    "M0 0A.1 1 0 0 1 0 0",
    "M0 0q. 0 0 0",
    "M0 0q-. 0 0 0",
    "M0 0q.0 0 0 0",
    "M0 0q-.0 0 0 0",
    "M0 0q.10 0 0 0",
    "M0 0q.0001 0 0 0",
    "M0 0q+.1 0 0 0",
    "M0 0q.1e2 0 0 0",
    "M1000000 0q.001 0 0 0",
    "M0-1000000a1 1 0 0 1 0-.001",
    "M0",
    "M0 0Q1 2 3",
    "M0 0A1 1 0 0 1 0",
    "q0 0 1 1",
    "a1 1 0 0 1 0 0",
    "M0 0l1 1",
    "M0 0c0 0 1 1 2 2",
    "M0 0z",
    "M0 0Zq0 0 1 1",
    "M1000000 0q0.001 0 0 0",
    "M1000000 0q0 0 0.001 0",
    "M0-1000000q0-0.001 0 0",
    "M0-1000000q0 0 0-0.001",
    "M1000000 0a1 1 0 0 1 0.001 0",
    "M0-1000000a1 1 0 0 1 0-0.001",
    "M0 0q1000000.001 0 0 0",
    "M0 0a0 1 0 0 1 0 0",
    "M0 0a1 1 1 0 1 0 0",
    "M0 0a1 1 0 2 1 0 0",
    "M0 0a1 1 0 0 2 0 0",
    "M0 0qNaN 0 0 0",
    "M0 0qInfinity 0 0 0",
    "M0 0q1e2 0 0 0",
    "M0 0q0.0001 0 0 0",
    "M0 0q-0 0 0 0",

    "M0 0q0 0 0",
    "M0 0a1 1 0 0 1 0",
    "M999999.999 0q0.001 0 0.001 0q0 0 0.001 0",
  ])("rejects unsafe or unsupported relative input: %s", (path) => {
    expect(validate(path)).toBeNull();
  });

  it("counts relative commands and numbers under the existing command cap", () => {
    expect(validate("M0 0q1 2 3 4a1 1 0 0 1 0 0Z")).toEqual({ commands: 4, numericTokens: 13 });
    expect(validate(`M0 0${"q0 0 0 0".repeat(200_000)}`, 16_384)).toBeNull();
  });
});
