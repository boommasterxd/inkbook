import { describe, expect, it, vi } from "vitest";
import { PORTABLE_PALETTE_V1 } from "../../../../src/domain/schema/public";
import { SVG_NAMESPACE } from "../../../../src/rendering/scene/constants";
import type { SceneToolCursor } from "../../../../src/rendering/scene/tool-cursor";
import { createAllElementSnapshot } from "../../../unit/persistence/serialization/fixtures";
import { createSceneFixture } from "../../../fixtures/rendering/scene";
import { FakeSceneStore, fakeNode } from "../../../unit/rendering/scene/fakes";

function setup() {
  const h = createSceneFixture(createAllElementSnapshot().page, new FakeSceneStore());
  h.scheduler.runAll();
  const scene = fakeNode(h.renderer.svg);
  const document = h.parentDocument;
  const surface = document.body.nodes[0]!;
  const cursor = surface.nodes[0]!;
  return { ...h, scene, document, surface, cursor };
}

describe("viewport tool cursor surface", () => {
  it("owns an inert cursor in the presentation document and removes it on disposal", () => {
    const h = setup();
    expect(h.surface.parent).toBe(h.document.body);
    expect(h.scene.ownerDocument).not.toBe(h.document);
    expect(h.renderer.inputSurface.ownerDocument).toBe(h.document);
    expect(h.cursor.parent).toBe(h.surface);
    expect(h.scene.nodes).not.toContain(h.cursor);
    expect(h.surface.attributes.get("class")).toBe("inkbook-tool-cursor-surface");
    expect(h.surface.attributes.get("aria-hidden")).toBe("true");
    expect(h.surface.attributes.get("pointer-events")).toBe("none");
    const other = setup();
    h.renderer.destroy();
    h.renderer.destroy();
    expect(h.document.body.nodes).toEqual([]);
    expect(h.surface.parent).toBeUndefined();
    expect(other.document.body.nodes).toEqual([other.surface]);
    other.renderer.destroy();
  });

  it.each(["light", "dark"] as const)(
    "copies the canonical %s palette outside the embed",
    (scheme) => {
      const h = setup();
      h.renderer.setScheme(scheme);
      h.scheduler.runAll();
      const palette = PORTABLE_PALETTE_V1[scheme];
      expect(h.surface.style["--inkbook-text"]).toBe(palette.text);
      expect(h.surface.style["--inkbook-page"]).toBe(palette.page);
      expect(h.surface.style["--inkbook-guide"]).toBe(palette.guide);
      h.renderer.destroy();
    },
  );

  it("retains cursor geometry while scroll clipping and camera state change independently", () => {
    const h = setup();
    const icon = h.document.createElementNS(SVG_NAMESPACE, "svg");
    let clip = { left: 20, top: 30, right: 520, bottom: 430 };
    const read = vi.fn(() => ({
      cursor: {
        kind: "tool",
        color: { type: "theme-text" },
        opacity: 1,
        x: 120,
        y: 80,
        icon: icon as unknown as SVGSVGElement,
        clip,
      } satisfies SceneToolCursor,
      system: "crosshair",
    }));
    h.renderer.requestToolCursorFrame(read);
    h.scheduler.runAll();
    const ring = h.cursor.nodes[0];
    const iconGroup = h.cursor.nodes[1]!;
    expect(h.surface.attributes.get("clip-path")).toBe(
      "polygon(20px 30px, 520px 30px, 520px 430px, 20px 430px)",
    );
    clip = { left: 20, top: 0, right: 520, bottom: 330 };
    read.mockClear();
    for (let sample = 0; sample < 10; sample += 1) h.renderer.invalidateLayout();
    expect(read).not.toHaveBeenCalled();
    h.scheduler.runAll();
    expect(read).toHaveBeenCalledExactlyOnceWith(true);
    expect(h.cursor.attributes.get("transform")).toBe("translate(120 80)");
    expect(h.surface.attributes.get("clip-path")).toBe(
      "polygon(20px 0px, 520px 0px, 520px 330px, 20px 330px)",
    );
    h.renderer.setCamera({ x: 15, zoom: 2 });
    h.scheduler.runAll();
    expect(h.surface.nodes[0]).toBe(h.cursor);
    expect(h.cursor.nodes).toEqual([ring, iconGroup]);
    expect(iconGroup.nodes).toEqual([icon]);
    expect(h.cursor.attributes.get("transform")).toBe("translate(120 80)");
    expect(h.surface.attributes.get("clip-path")).toBe(
      "polygon(20px 0px, 520px 0px, 520px 330px, 20px 330px)",
    );
    h.renderer.destroy();
  });
});
