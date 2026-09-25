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
    "M10 20H30V40h-.125v.25Z",
    "M999999.999-999999.999h.001v-.001H-1000000V1000000",
    "M0 0H999999.999h.001V-999999.999v-.001",
    "M1000000 1000000h-1000000v-1000000",

    "M0 0l1.2 3-4 5-.1-.2Z",
    "M-999999 0l-.5 0-.5 0",
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
});

describe("rejected relative and axis path data", () => {
  it.each([
    "M.1 0",
    "H0",
    "V0",
    "h0",
    "v0",
    "M0 0H.1",
    "M0 0V-.1",
    "M0 0h1-1",
    "M0 0v1-1",
    "M0 0H1 2",
    "M0 0V1 2",
    "M0 0Zh1",
    "M0 0Zv1",
    "M1000000 0h.001",
    "M-1000000 0h-.001",
    "M0 1000000v.001",
    "M0-1000000v-.001",
    "M0 0H1000001",
    "M0 0V-1000001",
    "M0 0h-0",
    "M0 0v1e2",
    "M0 0h.0001",

    "M0 0-1 0",
    "M0 0L1 1-1 0",
    "M0 0q0 0 1 1-1 0",
    "M0 0a1 1 0 0 0 1 1-1 0",
    "M0 0l1 1Z-1 0",
    "M0 0l1 1-1",
    "M0 0l1 1-0 0",
    "M0 0l1 1-1.0001 0",
    "M-999999 0l-.5 0-.501 0",
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
});

describe("relative and axis command budgets", () => {
  it("counts implicit lines against command and slice limits", () => {
    expect(validate("M0 0l1.2 3-4 5-.1-.2Z")).toEqual({ commands: 5, numericTokens: 8 });
    expect(validate(`M0 0l0 0${"-.001 0".repeat(399_999)}`, 16_384)).toBeNull();
    const steps = validatePathDataSteps("M0 0l1 1-1 0", { commandsPerStep: 1 });
    let yields = 0;
    let step = steps.next();
    while (!step.done) {
      yields += 1;
      step = steps.next();
    }
    expect(yields).toBe(3);
    expect(step.value).toEqual({ commands: 3, numericTokens: 6 });
  });

  it("bounds axis-command counts and yields before continuing their coordinates", () => {
    expect(validate("M10 20H30V40h-.125v.25Z")).toEqual({ commands: 6, numericTokens: 6 });
    expect(validate(`M0 0${"h0".repeat(400_000)}`, 16_384)).toBeNull();
    const steps = validatePathDataSteps("M10 20H30v-.25", { commandsPerStep: 1 });
    expect(steps.next().done).toBe(false);
    expect(steps.next().done).toBe(false);
    expect(steps.next().done).toBe(false);
    expect(steps.next()).toEqual({ done: true, value: { commands: 3, numericTokens: 4 } });
  });

  it("counts relative commands and numbers under the existing command cap", () => {
    expect(validate("M0 0q1 2 3 4a1 1 0 0 1 0 0Z")).toEqual({ commands: 4, numericTokens: 13 });
    expect(validate(`M0 0${"q0 0 0 0".repeat(400_000)}`, 16_384)).toBeNull();
  });
});
