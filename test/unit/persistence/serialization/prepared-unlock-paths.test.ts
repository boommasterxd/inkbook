import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PreparedUnlockPaths,
  isPreparedUnlockPaths,
  validatePreparedUnlockGeometry,
} from "../../../../src/persistence/serialization/prepared-unlock-paths";
import * as pathValidator from "../../../../src/persistence/documents/path-data-validator";
import { createAllElementSnapshot } from "./fixtures";

const stroke = createAllElementSnapshot().elements.find((element) => element.kind === "stroke")!;
const geometry = [{ d: "M0 0L1 1Z", paint: "fill" as const }];

afterEach(() => vi.restoreAllMocks());

describe("bounded prepared unlock paths", () => {
  it("checks between all short paths and stops validation immediately on cancellation", async () => {
    const paths = Array.from({ length: 1024 }, (_, index) => ({ id: String(index), geometry }));
    const scan = vi.spyOn(pathValidator, "validatePathDataSteps");
    const checkpoint = vi.fn(() => Promise.resolve());
    expect(await validatePreparedUnlockGeometry(paths, checkpoint)).toBe(true);
    expect(checkpoint).toHaveBeenCalledTimes(1024);
    expect(scan).toHaveBeenCalledTimes(1024);
    scan.mockClear();
    let visits = 0;
    await expect(
      validatePreparedUnlockGeometry(paths, async () => {
        visits += 1;
        if (visits === 4) throw new Error("cancelled");
      }),
    ).rejects.toThrow("cancelled");
    expect(scan).toHaveBeenCalledTimes(3);
  });

  it("retains only pressure strokes, caps entries and relinquishes ownership when taken", () => {
    const paths = new PreparedUnlockPaths();
    paths.observe({ ...stroke, style: { ...stroke.style, pressureEnabled: false } }, geometry);
    for (let index = 0; index < 1025; index += 1)
      paths.observe({ ...stroke, id: String(index) }, geometry);
    const taken = paths.take();
    expect(taken).toHaveLength(1024);
    expect(taken[0]!.geometry).toBe(geometry);
    expect(isPreparedUnlockPaths(taken)).toBe(true);
    expect(paths.take()).toEqual([]);
  });

  it("caps structured-clone storage while preserving room after oversized entries", () => {
    const paths = new PreparedUnlockPaths();
    paths.observe(stroke, [{ d: "M0 0" + "L0 0".repeat(600_000), paint: "fill" }]);
    paths.observe({ ...stroke, id: "small" }, geometry);
    expect(paths.take()).toEqual([{ id: "small", geometry }]);
    const padded = [{ d: "M0 0" + " ".repeat(400_000), paint: "fill" as const }];
    for (let index = 0; index < 10; index += 1)
      paths.observe({ ...stroke, id: String(index) }, padded);
    const retained = paths.take();
    expect(retained).toHaveLength(5);
    expect(isPreparedUnlockPaths(retained)).toBe(true);
    expect(isPreparedUnlockPaths([...retained, { id: "extra", geometry: padded }])).toBe(false);
  });

  it("scans path commands once with bounded checkpoints and propagates cancellation", async () => {
    const paths = [
      { id: "a", geometry: [{ d: "M0 0" + "L1 1".repeat(20_000), paint: "fill" as const }] },
    ];
    const checkpoint = vi.fn(() => Promise.resolve());
    expect(await validatePreparedUnlockGeometry(paths, checkpoint)).toBe(true);
    expect(checkpoint.mock.calls.length).toBeGreaterThan(1);
    expect(checkpoint.mock.calls.length).toBeLessThan(1000);
    expect(
      await validatePreparedUnlockGeometry(
        [{ id: "a", geometry: [{ d: "M0 0X1 1", paint: "fill" }] }],
        checkpoint,
      ),
    ).toBe(false);
    const cancelled = vi.fn(() => Promise.reject(new Error("cancelled")));
    await expect(validatePreparedUnlockGeometry(paths, cancelled)).rejects.toThrow("cancelled");
    expect(cancelled).toHaveBeenCalledTimes(1);
  });

  it.each([
    null,
    [{}],
    [{ id: "a", geometry: [null] }],
    [{ id: "a", geometry: [7] }],
    [Object.assign(Object.create({ id: "a", geometry }) as object, { foo: 1, bar: 2 })],
    [
      {
        id: "a",
        geometry: [Object.assign(Object.create(geometry[0]!) as object, { foo: 1, bar: 2 })],
      },
    ],
    [{ id: "a", geometry: [{ d: "M0 0", paint: "stroke" }] }],
    [{ id: "a", geometry, unexpected: true }],
    [{ id: "a", geometry: [{ ...geometry[0], onclick: "bad" }] }],
    [
      { id: "a", geometry },
      { id: "a", geometry },
    ],
    [{ id: "x".repeat(65), geometry }],
    [{ id: "a", geometry: [] }],
  ])("rejects malformed or ambiguous transport geometry %#", (value) => {
    expect(isPreparedUnlockPaths(value)).toBe(false);
  });
});
