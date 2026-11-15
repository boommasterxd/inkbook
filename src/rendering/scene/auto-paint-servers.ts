import type { Bounds } from "../../domain/geometry/primitives";
import { sharedAutoContrastBox } from "../../domain/images/auto-contrast";
import {
  createAutoPaintScope,
  setAutoPaintRegion,
  writeAutoPaintAttribute,
  type AutoPaintDefinitions,
} from "./auto-paint-definitions";

interface Server {
  readonly definitions: AutoPaintDefinitions;
  references: number;
}

export interface AutoPaintLease {
  readonly key: string;
  readonly patternId: string;
  release(): void;
}

/** Source shadow trees belong to shared scope tiles, never to individual ink nodes. */
export class AutoPaintServers {
  readonly #servers = new Map<string, Server>();

  public constructor(private readonly shared: AutoPaintDefinitions) {}

  public acquire(region: Bounds, sourceId: string, minimumStride: number): AutoPaintLease {
    const bounds = sharedAutoContrastBox(region, minimumStride);
    const key = `${sourceId} ${Object.values(bounds).join(" ")}`;
    let server = this.#servers.get(key);
    if (server === undefined) {
      const definitions = createAutoPaintScope(this.shared.owner, this.shared);
      if (sourceId !== definitions.underlayId)
        writeAutoPaintAttribute(this.shared.owner, definitions.source, "href", `#${sourceId}`);
      setAutoPaintRegion(definitions, bounds);
      server = { definitions, references: 0 };
      this.#servers.set(key, server);
    }
    server.references += 1;
    let released = false;
    return {
      key,
      patternId: server.definitions.patternId,
      release: () => {
        if (released) return;
        released = true;
        server.references -= 1;
        if (server.references !== 0) return;
        server.definitions.root.remove();
        this.#servers.delete(key);
      },
    };
  }

  public memoryUsage(): number {
    return this.#servers.size * 2048;
  }
}
