import { describe, expect, it, vi } from "vitest";
import * as tags from "../../../../src/persistence/documents/svg-tag";
import * as validator from "../../../../src/persistence/documents/path-data-validator";
import { serializeSvgEnvelope } from "../../../../src/persistence/documents/svg-envelope";
import { prepareStaticExportFragments } from "../../../../src/persistence/export/static-export-fragments";
import { StaticPathBounds } from "../../../../src/persistence/export/static-path-bounds";
import { createTestWorkScheduler } from "../../../fixtures/persistence/work-scheduler";
import { createWorkerSnapshot } from "../../../fixtures/persistence/worker-snapshot";

function envelope(content: string[]) {
  return serializeSvgEnvelope(createWorkerSnapshot([]), 100_000, {
    background: [],
    content,
    highlights: [],
  });
}

describe("static export fragment preparation work", () => {
  it("parses 10,000 mixed static paths once and keeps interspersed small arcs finite", async () => {
    const content = Array.from({ length: 10_000 }, (_, index) => {
      const y = index * 9;
      const command = index % 50 === 0 ? `A1 1 0 0 1 2 ${y}` : `L10 ${y + 5}`;
      return `<path d="M0 ${y} ${command}" stroke="#112233FF" stroke-width="2"/>`;
    });
    const svg = envelope(content);
    const parse = vi.spyOn(tags, "parseOpeningTag");
    const paths = vi.spyOn(validator, "validatePathDataSteps");
    const commands = vi.spyOn(StaticPathBounds.prototype, "observe");
    const fragments = vi.spyOn(StaticPathBounds.prototype, "painted");
    try {
      const result = await prepareStaticExportFragments(svg, {
        workScheduler: createTestWorkScheduler(),
      });
      expect(result).toHaveLength(10_000);
      expect(
        result!.every(({ minY, maxY }) => Number.isFinite(minY) && Number.isFinite(maxY)),
      ).toBe(true);
      expect(result![9999]).toEqual({ minY: 89987, maxY: 90000, background: false });
      expect(parse).toHaveBeenCalledTimes(10_006);
      expect(paths).toHaveBeenCalledTimes(10_000);
      expect(commands).toHaveBeenCalledTimes(20_000);
      expect(fragments).toHaveBeenCalledTimes(10_000);
    } finally {
      parse.mockRestore();
      paths.mockRestore();
      commands.mockRestore();
      fragments.mockRestore();
    }
  });

  it("cancels during a long path at the existing validator checkpoint and releases partial work", async () => {
    const svg = envelope([`<path d="M0 0${" L1 1".repeat(399_999)}" stroke="none"/>`]);
    const controller = new AbortController();
    const commands = vi.spyOn(StaticPathBounds.prototype, "observe");
    const fragments = vi.spyOn(StaticPathBounds.prototype, "painted");
    const workScheduler = createTestWorkScheduler({
      shouldYield: () => commands.mock.calls.length >= 100,
      checkpoint: () => {
        if (commands.mock.calls.length >= 100) controller.abort();
        return undefined;
      },
    });
    try {
      await expect(
        prepareStaticExportFragments(svg, { workScheduler, signal: controller.signal }),
      ).rejects.toThrow();
      expect(commands.mock.calls.length).toBeGreaterThanOrEqual(100);
      expect(commands.mock.calls.length).toBeLessThanOrEqual(128);
      expect(fragments).not.toHaveBeenCalled();
      expect(
        await prepareStaticExportFragments(envelope([]), {
          workScheduler: createTestWorkScheduler(),
        }),
      ).toEqual([]);
    } finally {
      commands.mockRestore();
      fragments.mockRestore();
    }
  });
});
