import type { Bounds } from "../../domain/geometry/primitives";
import {
  autoPaintLocalBounds,
  autoPaintBounds,
  autoPaintMinimumStride,
  autoPaintTransform,
  inverseAutoPaintTransform,
} from "./auto-paint-transform";
import { hasAutoPaintBounds, readAutoPaintBounds } from "./content/auto-paint-bounds";
import {
  createAutoPaintAlias,
  recordAutoPaintWrite,
  setAutoPaintRegion,
  writeAutoPaintAttribute,
  type AutoPaintAlias,
  type AutoPaintDefinitions,
} from "./auto-paint-definitions";
import { AutoPaintServers, type AutoPaintLease } from "./auto-paint-servers";

interface PaintScope {
  readonly node: SVGGElement;
  readonly id: string;
}

/** A tight client texture inherits a shared source tree in scope coordinates. */
export class AutoPaintAtom {
  readonly #definitions: AutoPaintAlias;
  #lease: AutoPaintLease | undefined;
  #inverse = "";
  #region = "";

  public constructor(
    private readonly node: SVGElement,
    private readonly shared: AutoPaintDefinitions,
    private readonly servers: AutoPaintServers,
  ) {
    this.#definitions = createAutoPaintAlias(shared.owner);
    node.style.setProperty("--inkbook-auto-paint", `url(#${this.#definitions.patternId})`);
    recordAutoPaintWrite(shared.owner);
  }

  public update(
    worldViewport: Bounds,
    root: SVGGElement,
    zoom: number,
    scope?: PaintScope,
  ): boolean {
    const viewport = autoPaintLocalBounds(worldViewport, autoPaintTransform(this.node, root));
    if (viewport === undefined) return false;
    const bounds = localBounds(this.node, root) ?? viewport;
    const region: Bounds = {
      minX: Math.max(bounds.minX, viewport.minX),
      minY: Math.max(bounds.minY, viewport.minY),
      maxX: Math.min(bounds.maxX, viewport.maxX),
      maxY: Math.min(bounds.maxY, viewport.maxY),
    };
    if (region.maxX <= region.minX || region.maxY <= region.minY) return true;
    const transform = autoPaintTransform(this.node, scope?.node ?? root);
    const scopeRegion = autoPaintBounds(region, transform);
    if (scopeRegion === undefined) return false;
    this.writeSource(scopeRegion, scope, root, zoom);
    const key = Object.values(scopeRegion).join(" ");
    if (this.#region !== key) {
      this.#region = key;
      setAutoPaintRegion(this.#definitions, scopeRegion);
    }
    return (
      bounds.minX < viewport.minX ||
      bounds.minY < viewport.minY ||
      bounds.maxX > viewport.maxX ||
      bounds.maxY > viewport.maxY
    );
  }

  public release(): void {
    this.#definitions.pattern.remove();
    this.#lease?.release();
    this.#lease = undefined;
    this.node.style.removeProperty("--inkbook-auto-paint");
    recordAutoPaintWrite(this.shared.owner);
  }

  private writeSource(
    region: Bounds,
    scope: PaintScope | undefined,
    root: SVGGElement,
    zoom: number,
  ): void {
    const sourceId = scope?.id ?? this.shared.underlayId;
    const stride = autoPaintMinimumStride(autoPaintTransform(scope?.node ?? root, root), zoom);
    const next = this.servers.acquire(region, sourceId, stride);
    if (this.#lease?.key !== next.key) {
      writeAutoPaintAttribute(
        this.shared.owner,
        this.#definitions.pattern,
        "href",
        `#${next.patternId}`,
      );
      this.#lease?.release();
      this.#lease = next;
    } else next.release();
    const inverse = inverseAutoPaintTransform(autoPaintTransform(this.node, scope?.node ?? root));
    if (inverse !== undefined && inverse !== this.#inverse) {
      this.#inverse = inverse;
      writeAutoPaintAttribute(
        this.shared.owner,
        this.#definitions.pattern,
        "patternTransform",
        inverse,
      );
    }
  }
}

function localBounds(node: SVGElement, root: SVGGElement): Bounds | undefined {
  for (
    let owner: SVGElement | null = node;
    owner !== null && owner !== root;
    owner = owner.parentElement as SVGElement | null
  ) {
    const bounds = readAutoPaintBounds(owner);
    if (hasAutoPaintBounds(owner))
      return owner === node
        ? bounds
        : bounds === undefined
          ? undefined
          : autoPaintLocalBounds(bounds, autoPaintTransform(node, owner as SVGGElement));
  }
  return undefined;
}
