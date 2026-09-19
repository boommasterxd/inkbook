import { describe, expect, it, vi } from "vitest";
import type { InkSnapshotV1 } from "../../../src/domain/schema/public";

import * as geometry from "../../../src/domain/geometry/element-path";
import { createAllElementSnapshot } from "../../unit/persistence/serialization/fixtures";
import * as pathMarkup from "../../../src/persistence/serialization/path-markup";
import { serializeInkbookDocument } from "../../../src/persistence/serialization/public";
import { StreamingStaticIntegrityMatcher } from "../../../src/persistence/serialization/streaming-static-integrity";
import { createPressureGroupFixture } from "./fixtures";

describe("pressure-group static integrity performance", () => {
  it("verifies 10,000 pressure groups through bounded input chunks", () => {
    const snapshot = createPressureGroupFixture();
    expect(snapshot.elements).toHaveLength(10_000);
    const serialized = serializeInkbookDocument(snapshot, { hash: () => "fixture-hash" });
    if (!serialized.ok) throw new Error(serialized.error.code);
    const current = serialized.value.svg.slice(
      serialized.value.svg.indexOf('<g id="inkbook-background">'),
    );
    expect(current.match(/<g opacity=/gu)).toHaveLength(10_000);
    const fragments = vi.spyOn(pathMarkup, "serializeElementPaths");
    const builds = vi.spyOn(geometry, "buildElementPathParts");
    const matcher = new StreamingStaticIntegrityMatcher(snapshot, serialized.value.lockedHeight);
    expect(fragments).not.toHaveBeenCalled();
    for (let offset = 0; offset < current.length; offset += 16 * 1024) {
      expect(matcher.write(current.slice(offset, offset + 16 * 1024))).toBe(true);
      if (offset === 0) expect(fragments.mock.calls.length).toBeLessThan(10_000);
    }
    expect(matcher.finish()).toBe(true);
    expect(fragments).toHaveBeenCalledTimes(10_000);
    expect(builds).toHaveBeenCalledTimes(10_000);
    builds.mockRestore();
    fragments.mockRestore();
  }, 120_000);
});

const arrowCases = [
  { nodes: ["arrow", "arrow"], style: "dashed", builds: 10_001 },
  { nodes: ["triangle", "circle"], style: "dashed", builds: 10_001 },
  { nodes: ["none", "none"], style: "dashed", builds: 10_000 },
  { nodes: ["none", "none"], style: "dotted", builds: 10_000 },
] as const;

it.each(
  arrowCases.flatMap((scenario) =>
    (["current", "rounded", "legacy"] as const).map((profile) => ({ ...scenario, profile })),
  ),
)(
  "bounds geometry work for 10,000 $style $nodes arrows ($profile)",
  ({ nodes, style, builds: expectedBuilds, profile }) => {
    const snapshot: InkSnapshotV1 = createPressureGroupFixture();
    const arrow = createAllElementSnapshot().elements.find((element) => element.kind === "arrow")!;
    snapshot.elements = snapshot.elements.map((element) => ({
      ...arrow,
      id: element.id,
      startNode: nodes[0],
      endNode: nodes[1],
      style: { ...arrow.style, outlineStyle: style },
    }));
    const serialized = serializeInkbookDocument(snapshot, { hash: () => "fixture-hash" });
    if (!serialized.ok) throw new Error(serialized.error.code);
    let suffix = serialized.value.svg.slice(
      serialized.value.svg.indexOf('<g id="inkbook-background">'),
    );
    if (profile !== "current") {
      const contentStart =
        suffix.indexOf('<g id="inkbook-content">') + '<g id="inkbook-content">'.length;
      suffix =
        suffix.slice(0, contentStart) +
        snapshot.elements
          .flatMap((element) => pathMarkup.serializeProfileElementPaths(element, profile))
          .map((path) =>
            profile === "legacy" && style !== "dotted"
              ? path.replace('stroke-linecap="round"', 'stroke-linecap="butt"')
              : path,
          )
          .join("") +
        "</g>\n</svg>";
    }
    const builds = vi.spyOn(geometry, "buildElementPathParts");
    const matcher = new StreamingStaticIntegrityMatcher(snapshot, serialized.value.lockedHeight);
    expect(builds).not.toHaveBeenCalled();
    for (let offset = 0; offset < suffix.length; offset += 16 * 1024) {
      expect(matcher.write(suffix.slice(offset, offset + 16 * 1024))).toBe(true);
      if (offset === 0) expect(builds.mock.calls.length).toBeLessThan(10_000);
    }
    expect(matcher.finish()).toBe(true);
    const rewrite =
      profile === "legacy" ? style !== "dotted" : profile === "rounded" && nodes[0] === "arrow";
    expect(matcher.requiresCanonicalRewrite).toBe(rewrite);
    expect(builds).toHaveBeenCalledTimes(expectedBuilds);
    builds.mockRestore();
  },
  120_000,
);
