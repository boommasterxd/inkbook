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
  let checkpoints = 0;
  let previous = [0, 0, 0];
  const observe = () => {
    const calls = [
      create.mock.calls.length,
      attributes.mock.calls.length,
      append.mock.calls.length,
    ];
    expect(calls[0]! - previous[0]!).toBeLessThanOrEqual(256);
    expect(calls[1]! - previous[1]!).toBeLessThanOrEqual(256 * 3 + 5);
    expect(calls[2]! - previous[2]!).toBeLessThanOrEqual(256);
    previous = calls;
  };
  const svg = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {
      checkpoints += 1;
      observe();
    },
    now: () => 0,
    isCancelled: () => false,
  });
  observe();
  expect(svg?.querySelectorAll("path")).toHaveLength(10_000);
  expect(svg?.isConnected).toBe(false);
  expect(create).toHaveBeenCalledTimes(10_002);
  expect(checkpoints).toBeLessThanOrEqual(40);
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
  let scannedUnits = 0;
  vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
    this: string,
    search: string,
    position?: number,
  ) {
    const offset = indexOf.call(this, search, position);
    if (["<", ">", "</metadata>"].includes(search)) {
      scanSizes.push(this.length);
      scannedUnits += offset < 0 ? this.length : offset + search.length;
    }
    return offset;
  });
  let beforePathCheckpoints = 0;
  const svg = await createPreviewSvgAsync(document, source, {
    checkpoint: async () => {
      expect(scanSizes.every((size) => size <= 16 * 1024 + 10)).toBe(true);
      expect(scannedUnits).toBeLessThanOrEqual(272 * 1024 + 10);
      scannedUnits = 0;
      scanSizes.length = 0;
      if (!attributes.mock.calls.some(([name]) => name === "d")) beforePathCheckpoints += 1;
    },
    now: () => 0,
    isCancelled: () => false,
  });
  expect(beforePathCheckpoints).toBeGreaterThanOrEqual(32);
  expect(beforePathCheckpoints).toBeLessThanOrEqual(34);
  expect(svg?.querySelector("path")?.getAttribute("d")).toBe(path);
  expect(attributes.mock.calls.filter(([name]) => name === "d")).toHaveLength(1);
});

it("completes a small preview in its initial bounded slice without continuation handoffs", async () => {
  const source = `<svg><metadata>${"x".repeat(96 * 1024)}</metadata>${'<path d="M0 0L1 1"/>'.repeat(100)}</svg>`;
  const create = vi.spyOn(document, "createElementNS");
  const checkpoint = vi.fn(async () => {});
  const svg = await createPreviewSvgAsync(document, source, {
    checkpoint,
    now: () => 0,
    isCancelled: () => false,
  });
  expect(checkpoint).toHaveBeenCalledExactlyOnceWith(true);
  expect(create).toHaveBeenCalledTimes(101);
  expect(svg?.querySelectorAll("path")).toHaveLength(100);
  expect(svg?.isConnected).toBe(false);
});
