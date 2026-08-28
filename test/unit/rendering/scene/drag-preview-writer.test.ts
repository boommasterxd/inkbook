import { describe, expect, it } from "vitest";

import { emptyAppliedLivePath, writeLivePath } from "../../../../src/rendering/scene/frame-writes";
import { createInstrumentation } from "../../../../src/rendering/scene/instrumentation";
import { SceneDom } from "../../../../src/rendering/scene/scene-dom";
import type { LivePathState } from "../../../../src/rendering/scene/types";

import { FakeDocument, FakeNode, asElement, fakeNode } from "./fakes";

describe("drag preview path writer", () => {
  it("reconciles separately presented path parts and clears them together", () => {
    const document = new FakeDocument();
    const container = new FakeNode(document, "div");
    const dom = new SceneDom(asElement(container), "Inkbook canvas", {});
    const instrumentation = createInstrumentation();
    const state: LivePathState = {
      parts: [
        {
          d: "M 0 0 L 100 0",
          presentation: presentation({ fill: "none", stroke: "#112233FF" }),
        },
        {
          d: "M 100 0 L 90 5 L 90 -5 Z",
          presentation: presentation({ fill: "#112233FF", stroke: "none" }),
        },
      ],
    };

    const applied = writeLivePath(dom, instrumentation, state, emptyAppliedLivePath());
    const liveGroup = fakeNode(dom.liveGroup);

    expect(fakeNode(dom.highlightGroup).attributes.get("class")).toContain(
      "inkbook-scene-foreground",
    );
    expect(fakeNode(dom.contentGroup).attributes.get("class")).toContain(
      "inkbook-scene-foreground",
    );
    expect(fakeNode(dom.motionGroup).attributes.get("class")).toContain("inkbook-scene-foreground");
    expect(liveGroup.attributes.get("class")).toBe("inkbook-scene-foreground");
    expect(fakeNode(dom.liveStrokeGroup).attributes.get("class")).toBe("inkbook-scene-foreground");
    expect(fakeNode(dom.svg).nodes[2]?.attributes.get("class")).toContain(
      "inkbook-scene-foreground",
    );
    expect(liveGroup.nodes).toHaveLength(2);
    expect(liveGroup.nodes[0]?.attributes.get("stroke")).toBe("#112233FF");
    expect(liveGroup.nodes[1]?.attributes.get("fill")).toBe("#112233FF");
    expect(liveGroup.nodes[1]?.attributes.get("stroke")).toBe("none");

    writeLivePath(dom, instrumentation, { parts: [] }, applied);
    expect(liveGroup.nodes).toHaveLength(1);
    expect(liveGroup.nodes[0]?.attributes.get("d")).toBe("");
    expect(liveGroup.nodes[0]?.attributes.has("fill")).toBe(false);
    expect(liveGroup.nodes[0]?.attributes.has("stroke")).toBe(false);
  });
});

function presentation(overrides: { readonly fill: string; readonly stroke: string }) {
  return {
    class: null,
    fill: overrides.fill,
    "fill-opacity": overrides.fill === "none" ? null : "1",
    "fill-rule": overrides.fill === "none" ? null : "nonzero",
    stroke: overrides.stroke,
    "stroke-dasharray": null,
    "stroke-linecap": overrides.stroke === "none" ? null : "butt",
    "stroke-linejoin": overrides.stroke === "none" ? null : "round",
    "stroke-opacity": overrides.stroke === "none" ? null : "1",
    "stroke-width": overrides.stroke === "none" ? null : "4",
  } as const;
}
