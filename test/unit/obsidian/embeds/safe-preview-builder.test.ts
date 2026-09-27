// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createPreviewSvgAsync } from "../../../../src/obsidian/embeds/safe-preview-builder";
import { configurePreviewSvg } from "../../../../src/obsidian/embeds/safe-preview-svg";
import { serializeInkbookDocument } from "../../../../src/persistence/serialization/public";
import { createSnapshot } from "../../persistence/serialization/fixtures";
import { immediateWorkScheduler } from "../../../fixtures/obsidian/immediate-work-scheduler";

function budgetScheduler(now: () => number, budget: () => number) {
  let started = now();
  return {
    ...immediateWorkScheduler(),
    shouldYield: () => now() - started >= budget(),
    nextFrame: async () => {
      started = now();
    },
  };
}

afterEach(() => vi.restoreAllMocks());

it("preserves the canonical detached preview without stylesheet or metadata", async () => {
  const serialized = serializeInkbookDocument(createSnapshot());
  if (!serialized.ok) throw new Error("Fixture serialization failed.");
  const source = serialized.value.svg;
  const expected = new DOMParser().parseFromString(source, "image/svg+xml")
    .documentElement as unknown as SVGSVGElement;
  expected.querySelector("metadata")?.remove();
  expected.querySelector("style")?.remove();
  configurePreviewSvg(expected);
  const parse = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const imported = vi.spyOn(document, "importNode");
  const actual = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {},
    workScheduler: immediateWorkScheduler(),
    isCancelled: () => false,
  });
  expect(actual?.outerHTML).toBe(expected.outerHTML);
  expect(actual?.isConnected).toBe(false);
  expect(actual?.querySelector("metadata, style")).toBeNull();
  expect(parse).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
});

it("cancels before building any SVG when the initial idle wait is invalidated", async () => {
  const create = vi.spyOn(document, "createElementNS");
  expect(
    await createPreviewSvgAsync(document, "", {
      checkpoint: async () => {},
      workScheduler: immediateWorkScheduler(),
      isCancelled: () => true,
    }),
  ).toBeUndefined();
  expect(create).not.toHaveBeenCalled();
});

it("bounds element creation and cancels a partially built detached tree", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata>' +
    '<g opacity="0.5"><path d="M0 0L1 1"/></g>'.repeat(10_000) +
    "</svg>";
  const create = vi.spyOn(document, "createElementNS");
  let previous = 0;
  let checkpoints = 0;
  const result = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {
      expect(create.mock.calls.length - previous).toBeLessThanOrEqual(256);
      previous = create.mock.calls.length;
      checkpoints += 1;
    },
    workScheduler: immediateWorkScheduler(),
    isCancelled: () => checkpoints === 5,
  });
  expect(result).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(1024);
});

it("yields during long metadata scanning before constructing content", async () => {
  const source = "<svg><metadata>" + "x".repeat(1024 * 1024) + '</metadata><path d="M0 0"/></svg>';
  const create = vi.spyOn(document, "createElementNS");
  let checkpoints = 0;
  expect(
    await createPreviewSvgAsync(document, source, {
      checkpoint: async () => {
        checkpoints += 1;
      },
      workScheduler: immediateWorkScheduler(),
      isCancelled: () => checkpoints === 4,
    }),
  ).toBeUndefined();
  expect(create).toHaveBeenCalledTimes(1);
});

it.each(["<svg><foreignObject/></svg>", '<svg><path d="M0 0"/>', "<g></g>"])(
  "rejects unexpected or truncated markup: %s",
  async (source) => {
    await expect(
      createPreviewSvgAsync(document, source, {
        checkpoint: async () => {},
        workScheduler: immediateWorkScheduler(),
        isCancelled: () => false,
      }),
    ).rejects.toThrow("validated Inkbook preview");
  },
);

it.each([60, 90, 120, 144, 240])(
  "checks the %i Hz deadline between actual DOM creations in the initial and later slices",
  async (refreshRate) => {
    let time = 0;
    const budget = (1000 / refreshRate) * 0.55;
    const create = document.createElementNS.bind(document);
    const created = vi.spyOn(document, "createElementNS").mockImplementation((...args) => {
      time += 1;
      return create(...args);
    });
    let previous = 0;
    const batches: number[] = [];
    const observe = () => {
      const count = created.mock.calls.length - previous;
      expect(count).toBeLessThanOrEqual(Math.ceil(budget));
      batches.push(count);
      previous = created.mock.calls.length;
    };
    const svg = await createPreviewSvgAsync(
      document,
      `<svg>${'<path d="M0 0"/>'.repeat(64)}</svg>`,
      {
        checkpoint: async () => observe(),
        isCancelled: () => false,
        workScheduler: budgetScheduler(
          () => time,
          () => budget,
        ),
      },
    );
    observe();
    expect(svg?.querySelectorAll("path")).toHaveLength(64);
    expect(batches[0]).toBe(0);
    expect(batches.filter((count) => count > 0).length).toBeGreaterThan(1);
  },
);

it("rechecks a changed refresh budget within a running slice and after continuation", async () => {
  let time = 0;
  let refreshRate = 60;
  let count = 0;
  const create = document.createElementNS.bind(document);
  vi.spyOn(document, "createElementNS").mockImplementation((...args) => {
    time += 1;
    count += 1;
    if (count === 3) refreshRate = 240;
    return create(...args);
  });
  const batches: number[] = [];
  let previous = 0;
  const scheduler = budgetScheduler(
    () => time,
    () => (1000 / refreshRate) * 0.55,
  );
  await createPreviewSvgAsync(document, `<svg>${'<path d="M0 0"/>'.repeat(20)}</svg>`, {
    checkpoint: async () => {
      batches.push(count - previous);
      previous = count;
      if (count === 6) refreshRate = 60;
      await scheduler.nextFrame();
    },
    isCancelled: () => false,
    workScheduler: scheduler,
  });
  batches.push(count - previous);
  expect(batches).toEqual([0, 3, 3, 10, 5]);
});

it("yields before creating a node when a token scan exhausts the current time budget", async () => {
  let time = 0;
  // eslint-disable-next-line @typescript-eslint/unbound-method -- Preserve the original receiver via .call.
  const indexOf = String.prototype.indexOf;
  vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    if (search === "<" || search === ">") time += 3;
    return indexOf.call(this, search, position);
  });
  const create = vi.spyOn(document, "createElementNS");
  const checkpoints: number[] = [];
  const svg = await createPreviewSvgAsync(document, "<svg/>", {
    checkpoint: async () => {
      checkpoints.push(create.mock.calls.length);
    },
    isCancelled: () => false,
    workScheduler: budgetScheduler(
      () => time,
      () => 2,
    ),
  });
  expect(checkpoints.slice(0, 3)).toEqual([0, 0, 0]);
  expect(svg?.localName).toBe("svg");
  expect(create).toHaveBeenCalledOnce();
});
