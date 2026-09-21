// @vitest-environment happy-dom

import { afterEach, expect, it, vi } from "vitest";
import { createPreviewSvgAsync } from "../../../src/obsidian/embeds/safe-preview-builder";

afterEach(() => vi.restoreAllMocks());

it("builds ten thousand detached paths with bounded DOM writes between checkpoints", async () => {
  const source =
    '<svg xmlns="http://www.w3.org/2000/svg"><metadata></metadata><g>' +
    '<path d="M0 0L1 1" fill="none" stroke="#000000FF"/>'.repeat(10_000) +
    "</g></svg>";
  const create = vi.spyOn(document, "createElementNS");
  const attributes = vi.spyOn(window.Element.prototype, "setAttribute");
  const append = vi.spyOn(window.Element.prototype, "append");
  const parse = vi.spyOn(window.DOMParser.prototype, "parseFromString");
  const imported = vi.spyOn(document, "importNode");
  let previous = [0, 0, 0];
  const observe = () => {
    const calls = [
      create.mock.calls.length,
      attributes.mock.calls.length,
      append.mock.calls.length,
    ];
    expect(calls[0]! - previous[0]!).toBeLessThanOrEqual(32);
    expect(calls[1]! - previous[1]!).toBeLessThanOrEqual(32 * 3 + 5);
    expect(calls[2]! - previous[2]!).toBeLessThanOrEqual(32);
    previous = calls;
  };
  const svg = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {
      observe();
    },
    now: () => 0,
    isCancelled: () => false,
  });
  observe();
  expect(svg?.querySelectorAll("path")).toHaveLength(10_000);
  expect(svg?.isConnected).toBe(false);
  expect(create).toHaveBeenCalledTimes(10_002);
  expect(parse).not.toHaveBeenCalled();
  expect(imported).not.toHaveBeenCalled();
});

it("scans a maximum-size validated path incrementally before the atomic attribute write", async () => {
  // The envelope permits up to 8 MiB per path; one SVG d assignment remains atomic.
  const path = "M0 0" + " ".repeat(8 * 1024 * 1024 - 4);
  const source = `<svg><metadata></metadata><path d="${path}"/></svg>`;
  const attributes = vi.spyOn(window.Element.prototype, "setAttribute");
  // Preserve the receiver explicitly via .call in the scanning observer below.
  // eslint-disable-next-line @typescript-eslint/unbound-method -- The observer forwards the original receiver with .call.
  const indexOf = String.prototype.indexOf;
  const scanSizes: number[] = [];
  vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    if (["<", ">", "</metadata>"].includes(search)) scanSizes.push(this.length);
    return indexOf.call(this, search, position);
  });
  let beforePathCheckpoints = 0;
  const svg = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {
      expect(scanSizes.every((size) => size <= 16 * 1024 + 10)).toBe(true);
      scanSizes.length = 0;
      if (!attributes.mock.calls.some(([name]) => name === "d")) beforePathCheckpoints += 1;
    },
    now: () => 0,
    isCancelled: () => false,
  });
  expect(beforePathCheckpoints).toBeGreaterThanOrEqual(512);
  expect(svg?.querySelector("path")?.getAttribute("d")).toBe(path);
  expect(attributes.mock.calls.filter(([name]) => name === "d")).toHaveLength(1);
});
