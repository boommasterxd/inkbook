import { Window } from "happy-dom";
import { afterEach, vi } from "vitest";
import { buildElementPathParts } from "../../../src/domain/geometry/element-path";
import { createMountedElement } from "../../../src/rendering/scene/content/mounted-element";
import { createInstrumentation } from "../../../src/rendering/scene/instrumentation";
import { SceneRunStrokeWidth } from "../../../src/rendering/scene/presentation/selection-run-width";
import { fakeRectangleRecord } from "../../unit/rendering/scene/fakes";

export const NS = "http://www.w3.org/2000/svg";
export const WIDTH = "data-inkbook-run-width";
export const DASH = "data-inkbook-run-dash";
export const ACTIVE = "data-inkbook-run-active";
const windows: Window[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.close();
});

export function fixture() {
  const window = new Window();
  windows.push(window);
  const document = window.document as unknown as Document;
  const svg = document.createElementNS(NS, "svg");
  const group = document.createElementNS(NS, "g");
  svg.append(group);
  document.body.append(svg);
  const instrumentation = createInstrumentation();
  let zoom = 2;
  const readZoom = vi.fn(() => zoom);
  const width = new SceneRunStrokeWidth({
    svg,
    instrumentation,
    zoom: readZoom,
  });
  const mount = (record = fakeRectangleRecord("shape", 0, 0)) => {
    const entry = createMountedElement(
      document,
      record,
      buildElementPathParts(record.element),
      instrumentation,
    );
    if (entry.group !== null) group.append(entry.group);
    else for (const path of entry.paths) group.append(path.node);
    return entry;
  };
  return {
    svg,
    group,
    document,
    instrumentation,
    width,
    mount,
    readZoom,
    setZoom: (value: number) => {
      zoom = value;
    },
  };
}

export function palette(group: SVGGElement, node: SVGPathElement, kind: "width" | "dash"): string {
  return group.style.getPropertyValue(
    `--inkbook-run-${kind}-${node.getAttribute(kind === "width" ? WIDTH : DASH)}`,
  );
}
