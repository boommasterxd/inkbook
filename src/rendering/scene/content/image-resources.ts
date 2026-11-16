import type { ImageResourceV3 } from "../../../domain/schema/public";
import { SVG_NAMESPACE } from "../constants";

export interface SceneImageLease {
  readonly href: string;
  release(): void;
}

interface SharedImage {
  readonly bytes: number;
  readonly node: SVGImageElement;
  readonly href: string;
  references: number;
}

let nextImageId = 0;

/** Shares one native image decoder/source per referenced immutable asset in this scene. */
export class SceneImageResources {
  readonly #entries = new Map<string, SharedImage>();
  #bytes = 0;
  public constructor(
    private readonly defs: SVGDefsElement,
    private readonly resolve: (id: string) => ImageResourceV3 | undefined,
  ) {}

  public acquire(id: string): SceneImageLease {
    let entry = this.#entries.get(id);
    if (entry === undefined) {
      const resource = this.resolve(id);
      if (resource === undefined) throw new Error("The image resource is unavailable.");
      const node = this.defs.ownerDocument.createElementNS(SVG_NAMESPACE, "image");
      const nodeId = `inkbook-scene-image-${String(++nextImageId)}`;
      const data = resource.data;
      node.setAttribute("id", nodeId);
      node.setAttribute("width", String(resource.width));
      node.setAttribute("height", String(resource.height));
      node.setAttribute("preserveAspectRatio", "none");
      node.setAttribute("href", `data:${resource.mimeType};base64,${data}`);
      this.defs.append(node);
      const bytes = 512 + data.length * 2 + resource.width * resource.height * 4;
      entry = { node, href: `#${nodeId}`, references: 0, bytes };
      this.#entries.set(id, entry);
      this.#bytes += bytes;
    }
    const owned = entry;
    owned.references += 1;
    let released = false;
    return {
      href: owned.href,
      release: () => {
        if (released) return;
        released = true;
        owned.references -= 1;
        if (owned.references !== 0) return;
        owned.node.remove();
        if (this.#entries.get(id) === owned) {
          this.#entries.delete(id);
          this.#bytes -= owned.bytes;
        }
      },
    };
  }

  public release(): void {
    for (const entry of this.#entries.values()) entry.node.remove();
    this.#entries.clear();
    this.#bytes = 0;
  }

  /** Includes a conservative RGBA decoder estimate; browser allocation is platform-owned. */
  public memoryUsage(): number {
    return this.#bytes;
  }
}
