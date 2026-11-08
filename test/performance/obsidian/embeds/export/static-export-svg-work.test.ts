// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import * as tags from "../../../../../src/persistence/documents/svg-tag";
import * as validation from "../../../../../src/persistence/documents/path-data-validator";
import * as scanner from "../../../../../src/persistence/export/static-svg-scanner";
import * as outlines from "../../../../../src/domain/geometry/pressure/pressure-outline";
import { StaticPathBounds } from "../../../../../src/persistence/export/static-path-bounds";
import {
  createPreparedStaticExportSvg,
  createStaticExportSvg,
} from "../../../../../src/obsidian/embeds/export/static-export-svg";
import { inspectPreviewSvg } from "../../../../../src/obsidian/embeds/preview/safe-preview-svg";
import { createCapacityExportSvg } from "../../../../fixtures/persistence/export-geometry";
import { immediateWorkScheduler } from "../../../../fixtures/obsidian/immediate-work-scheduler";

afterEach(() => vi.restoreAllMocks());

it("scans saved ten-thousand-stroke markup once for bounds and detached DOM, then builds warm DOM without commands", async () => {
  const descriptor = await inspectPreviewSvg(createCapacityExportSvg(true), {
    workScheduler: immediateWorkScheduler(),
  });
  if (descriptor === null) throw new Error("Expected safe saved export geometry.");
  const parse = vi.spyOn(tags, "parseOpeningTag");
  const paths = vi.spyOn(validation, "validatePathDataSteps");
  const commands = vi.spyOn(StaticPathBounds.prototype, "observe");
  const bounds = vi.spyOn(StaticPathBounds.prototype, "painted");
  const scan = vi.spyOn(scanner, "findStaticSvgTokenSteps");
  const contours = vi.spyOn(outlines, "buildPressureOutline");
  const create = vi.spyOn(document, "createElementNS");
  const attributes = vi.spyOn(window.Element.prototype, "setAttribute");
  const append = vi.spyOn(window.Element.prototype, "append");
  const total = { tags: 0, paths: 0, commands: 0, bounds: 0, metadata: 0, style: 0, create: 0 };
  const observe = () => {
    expect(create.mock.calls.length).toBeLessThanOrEqual(256);
    expect(attributes.mock.calls.length).toBeLessThanOrEqual(256 * 8 + 20);
    expect(append.mock.calls.length).toBeLessThanOrEqual(256);
    total.tags += parse.mock.calls.length;
    total.paths += paths.mock.calls.length;
    total.commands += commands.mock.calls.length;
    total.bounds += bounds.mock.calls.length;
    total.create += create.mock.calls.length;
    total.metadata += scan.mock.calls.filter(([, token]) => token === "</metadata>").length;
    total.style += scan.mock.calls.filter(([, token]) => token === "</style>").length;
    for (const boundary of [create, attributes, append, parse, paths, commands, bounds, scan])
      boundary.mockClear();
  };
  const shouldYield = () => create.mock.calls.length >= 256;
  const workScheduler = {
    ...immediateWorkScheduler(shouldYield),
    checkpoint: () => {
      observe();
      return undefined;
    },
  };
  let prepared = await createPreparedStaticExportSvg(document, descriptor, {
    signal: new AbortController().signal,
    workScheduler,
  });
  observe();
  expect(prepared?.svg.isConnected).toBe(false);
  expect(prepared?.fragments).toHaveLength(10_001);
  expect(prepared?.fragments.filter((fragment) => fragment.background)).toHaveLength(1);
  const pathData = [...prepared!.svg.querySelectorAll("path")].map((path) =>
    path.getAttribute("d"),
  );
  expect(pathData).toHaveLength(10_001);
  const expectedTags = descriptor.safeSvg.match(/<(?!\/)[a-z]/gu)!.length;
  expect(total.tags).toBe(expectedTags);
  expect(total.paths).toBe(10_001);
  const expectedCommands = pathData.reduce(
    (count, data) => count + (data?.match(/[MLCQAZHVmlcqazhv]/gu)?.length ?? 0),
    0,
  );
  expect(total.commands).toBe(expectedCommands);
  expect(total.bounds).toBe(10_001);
  expect(total.metadata).toBe(1);
  expect(total.style).toBe(1);
  expect(total.create).toBe(10_005);
  expect(contours).not.toHaveBeenCalled();
  expect(prepared!.fragments[10_000]!.minY).toBeGreaterThan(99_900);
  expect(prepared!.fragments[10_000]!.maxY).toBeLessThan(100_100);

  prepared = undefined;
  for (const key of Object.keys(total) as (keyof typeof total)[]) total[key] = 0;
  const warm = await createStaticExportSvg(document, descriptor, {
    signal: new AbortController().signal,
    workScheduler,
  });
  observe();
  expect([...warm!.querySelectorAll("path")].map((path) => path.getAttribute("d"))).toEqual(
    pathData,
  );
  expect(total.create).toBe(10_005);
  expect(total.paths).toBe(0);
  expect(total.commands).toBe(0);
  expect(total.bounds).toBe(0);
  expect(contours).not.toHaveBeenCalled();
});
