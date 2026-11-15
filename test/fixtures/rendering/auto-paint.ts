import { FakeDocument, FakeNode, asDocument } from "../../unit/rendering/scene/fakes";
import { SceneAutoPaint } from "../../../src/rendering/scene/scene-auto-paint";
import { createInstrumentation } from "../../../src/rendering/scene/instrumentation";
import { writeAutoPaintBounds } from "../../../src/rendering/scene/content/auto-paint-bounds";

const NS = "http://www.w3.org/2000/svg";
class PaintDocument extends FakeDocument {
  public reads = 0;
  public writes = 0;
  public geometryWrites = 0;
  public created = 0;
  public override createElementNS(_namespace: string, name: string): FakeNode {
    this.created += 1;
    return new PaintNode(this, name);
  }
}
class PaintNode extends FakeNode {
  public readonly nodeType = 1;
  public readonly namespaceURI = NS;
  public override hasChildNodes(): boolean {
    (this.ownerDocument as PaintDocument).reads += 1;
    return super.hasChildNodes();
  }
  public override getAttribute(name: string): string | null {
    (this.ownerDocument as PaintDocument).reads += 1;
    return super.getAttribute(name);
  }
  public override setAttribute(name: string, value: string): void {
    (this.ownerDocument as PaintDocument).writes += 1;
    if (name === "d") (this.ownerDocument as PaintDocument).geometryWrites += 1;
    super.setAttribute(name, value);
  }
  public prepend(...nodes: FakeNode[]): void {
    for (const node of [...nodes].reverse()) this.insertBefore(node, this.nodes[0] ?? null);
  }
}

export function autoPaintFixture(imageCount = 1) {
  const fake = new PaintDocument();
  const document = asDocument(fake);
  const create = <K extends keyof SVGElementTagNameMap>(name: K) =>
    document.createElementNS(NS, name);
  const svg = create("svg");
  const root = create("g");
  const page = create("path");
  const images = create("g");
  const scope = create("g");
  const defs = create("defs");
  svg.append(root, defs);
  root.append(page, images, scope);
  scope.setAttribute("data-inkbook-auto-scope", "");
  const records: MutationRecord[] = [];
  let observing = false;
  class Observer {
    public observe(): void {
      observing = true;
    }
    public disconnect(): void {
      observing = false;
      records.length = 0;
    }
    public takeRecords(): MutationRecord[] {
      return records.splice(0);
    }
  }
  const instrumentation = createInstrumentation();
  const manager = new SceneAutoPaint({
    defs,
    page,
    images,
    root,
    observer: Observer,
    hasImages: () => imageCount !== 0,
    invalidate: () => undefined,
    instrumentation,
  });
  const viewport = { left: 0, top: 0, width: 800, height: 400 };
  let camera = { x: 0, zoom: 1 };
  const flush = (deadline = Infinity, now = () => 0) =>
    manager.flush(viewport, camera, deadline, now);
  const changed = (node: SVGElement, attributeName = "transform") =>
    records.push({
      type: "attributes",
      target: node,
      attributeName,
    } as unknown as MutationRecord);
  const mount = (offset = 10) => {
    const node = create("path");
    node.setAttribute("class", "inkbook-theme-stroke");
    node.setAttribute("d", "M0 10H40");
    node.setAttribute("transform", `translate(${offset} 0)`);
    writeAutoPaintBounds(node, { minX: -2, minY: 8, maxX: 42, maxY: 12 });
    scope.append(node);
    return node;
  };
  return {
    manager,
    fake,
    svg,
    root,
    images,
    scope,
    defs,
    instrumentation,
    flush,
    changed,
    mount,
    observing: () => observing,
    setCamera: (value: typeof camera) => {
      camera = value;
    },
    paintNodes: () => {
      const result: FakeNode[] = [];
      const pending = [...(defs as unknown as FakeNode).nodes];
      while (pending.length !== 0) {
        const node = pending.pop()!;
        result.push(node);
        pending.push(...node.nodes);
      }
      return result;
    },
    setImages: (count: number) => {
      imageCount = count;
    },
  };
}
