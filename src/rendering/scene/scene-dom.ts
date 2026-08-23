import { PAGE_WIDTH, PORTABLE_PALETTE_V1, type BackgroundV1 } from "../../domain/schema/public";
import type { RenderBand } from "../../domain/commands/render-bands";
import { SVG_NAMESPACE } from "./constants";
import type { DocumentScheme, SceneInputHandlers } from "./types";

type InputEventName = keyof SceneInputHandlers;

let nextBackgroundPatternId = 0;

const ACTIVE_THEME_STYLESHEET =
  ".inkbook-theme-page{fill:var(--inkbook-page)}" +
  ".inkbook-theme-guide{stroke:var(--inkbook-guide);shape-rendering:crispEdges}" +
  ".inkbook-theme-stroke{stroke:var(--inkbook-text)}" +
  ".inkbook-theme-fill{fill:var(--inkbook-text)}" +
  ".inkbook-theme-stroke-fill{stroke:var(--inkbook-text);fill:var(--inkbook-text)}" +
  "[data-inkbook-motion]{transform-box:fill-box;transform-origin:center}";

export class SceneDom {
  public readonly backgroundPath: SVGPathElement;
  public readonly backgroundOutgoingPath: SVGPathElement;
  public readonly cameraGroup: SVGGElement;
  public readonly contentGroup: SVGGElement;
  public readonly highlightGroup: SVGGElement;
  public readonly inputSurface: HTMLDivElement;
  public readonly liveGroup: SVGGElement;
  public readonly liveStrokeGroup: SVGGElement;
  public readonly livePath: SVGPathElement;
  public readonly motionGroup: SVGGElement;
  public readonly overlayPath: SVGPathElement;
  public readonly selectionOverlayPath: SVGPathElement;
  public readonly snapMarkerPath: SVGPathElement;
  public readonly ownerDocument: Document;
  public readonly pageSurface: SVGPathElement;
  public readonly svg: SVGSVGElement;
  readonly #backgroundPattern: SVGPatternElement;
  readonly #backgroundPatternPath: SVGPathElement;
  readonly #backgroundPatternId: string;
  readonly #outgoingBackgroundPattern: SVGPatternElement;
  readonly #outgoingBackgroundPatternPath: SVGPathElement;
  readonly #outgoingBackgroundPatternId: string;
  #livePathBand: RenderBand = "content";
  #liveStrokeBand: RenderBand = "content";
  readonly #listeners: { name: InputEventName; listener: EventListener }[] = [];

  public constructor(container: HTMLElement, accessibleName: string, handlers: SceneInputHandlers) {
    this.ownerDocument = container.ownerDocument;
    this.svg = this.createSvg("svg");
    this.cameraGroup = this.createSvg("g");
    this.pageSurface = this.createSvg("path");
    this.backgroundPath = this.createSvg("path");
    this.backgroundOutgoingPath = this.createSvg("path");
    this.#backgroundPattern = this.createSvg("pattern");
    this.#backgroundPatternPath = this.createSvg("path");
    this.#outgoingBackgroundPattern = this.createSvg("pattern");
    this.#outgoingBackgroundPatternPath = this.createSvg("path");
    nextBackgroundPatternId += 1;
    this.#backgroundPatternId = `inkbook-background-pattern-${String(nextBackgroundPatternId)}`;
    this.#outgoingBackgroundPatternId = `${this.#backgroundPatternId}-outgoing`;
    this.highlightGroup = this.createSvg("g");
    this.contentGroup = this.createSvg("g");
    this.motionGroup = this.createSvg("g");
    this.liveGroup = this.createSvg("g");
    this.livePath = this.createSvg("path");
    this.liveStrokeGroup = this.createSvg("g");
    const overlayGroup = this.createSvg("g");
    this.overlayPath = this.createSvg("path");
    this.selectionOverlayPath = this.createSvg("path");
    this.snapMarkerPath = this.createSvg("path");
    const themeStyle = this.createSvg("style");
    this.inputSurface = this.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "div",
    ) as HTMLDivElement;

    this.svg.setAttribute("aria-hidden", "true");
    this.svg.setAttribute("class", "inkbook-scene");
    this.svg.setAttribute("preserveAspectRatio", "none");
    this.pageSurface.setAttribute("class", "inkbook-theme-page");
    this.pageSurface.setAttribute("fill", PORTABLE_PALETTE_V1.light.page);
    this.backgroundPath.setAttribute("fill", "none");
    this.backgroundPath.setAttribute("pointer-events", "none");
    this.backgroundOutgoingPath.setAttribute("pointer-events", "none");
    this.#backgroundPattern.setAttribute("id", this.#backgroundPatternId);
    this.#backgroundPattern.setAttribute("patternUnits", "userSpaceOnUse");
    this.#backgroundPatternPath.setAttribute("class", "inkbook-theme-guide");
    this.#backgroundPatternPath.setAttribute("fill", "none");
    this.#backgroundPatternPath.setAttribute("vector-effect", "non-scaling-stroke");
    this.#backgroundPattern.append(this.#backgroundPatternPath);
    this.#outgoingBackgroundPattern.setAttribute("id", this.#outgoingBackgroundPatternId);
    this.#outgoingBackgroundPattern.setAttribute("patternUnits", "userSpaceOnUse");
    this.#outgoingBackgroundPatternPath.setAttribute("class", "inkbook-theme-guide");
    this.#outgoingBackgroundPatternPath.setAttribute("fill", "none");
    this.#outgoingBackgroundPatternPath.setAttribute("vector-effect", "non-scaling-stroke");
    this.#outgoingBackgroundPattern.append(this.#outgoingBackgroundPatternPath);
    this.highlightGroup.setAttribute("pointer-events", "none");
    this.highlightGroup.setAttribute("class", "inkbook-scene-highlights");
    this.contentGroup.setAttribute("pointer-events", "none");
    this.contentGroup.setAttribute("class", "inkbook-scene-content");
    this.motionGroup.setAttribute("aria-hidden", "true");
    this.motionGroup.setAttribute("class", "inkbook-scene-motion");
    this.motionGroup.setAttribute("pointer-events", "none");
    this.liveGroup.setAttribute("pointer-events", "none");
    this.liveStrokeGroup.setAttribute("pointer-events", "none");
    overlayGroup.setAttribute("pointer-events", "none");
    overlayGroup.setAttribute("class", "inkbook-scene-overlays");
    this.livePath.setAttribute("pointer-events", "none");
    this.overlayPath.setAttribute("pointer-events", "none");
    this.selectionOverlayPath.setAttribute("pointer-events", "none");
    this.snapMarkerPath.setAttribute("pointer-events", "none");
    themeStyle.textContent = ACTIVE_THEME_STYLESHEET;

    this.cameraGroup.append(
      this.pageSurface,
      this.backgroundPath,
      this.highlightGroup,
      this.contentGroup,
      this.liveGroup,
      this.liveStrokeGroup,
      this.backgroundOutgoingPath,
      this.motionGroup,
    );
    this.liveGroup.append(this.livePath);
    overlayGroup.append(this.overlayPath, this.selectionOverlayPath, this.snapMarkerPath);
    const defs = this.createSvg("defs");
    defs.append(this.#backgroundPattern, this.#outgoingBackgroundPattern);
    this.svg.append(themeStyle, this.cameraGroup, overlayGroup, defs);

    this.inputSurface.tabIndex = 0;
    this.inputSurface.setAttribute("class", "inkbook-canvas-input");
    this.inputSurface.setAttribute("aria-label", accessibleName);
    this.inputSurface.setAttribute("role", "application");
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("pointer-events", "none");

    this.attachHandlers(handlers);
    container.append(this.svg, this.inputSurface);
    this.setPageHeight(1);
  }

  public group(band: "content" | "highlight"): SVGGElement {
    return band === "highlight" ? this.highlightGroup : this.contentGroup;
  }

  /**
   * Places an imperative preview group without changing the persisted band DOM.
   * The group remains separate from committed elements so shared band ordering
   * reconciliation cannot accidentally treat a live preview as committed ink.
   */
  public placeLiveGroup(kind: "path" | "stroke", band: RenderBand): void {
    const currentBand = kind === "path" ? this.#livePathBand : this.#liveStrokeBand;
    if (currentBand === band) return;
    const group = kind === "path" ? this.liveGroup : this.liveStrokeGroup;
    if (band === "highlight") {
      this.highlightGroup.append(group);
    } else if (kind === "path" && this.#liveStrokeBand === "content") {
      this.cameraGroup.insertBefore(group, this.liveStrokeGroup);
    } else {
      this.cameraGroup.insertBefore(group, this.backgroundOutgoingPath);
    }
    if (kind === "path") this.#livePathBand = band;
    else this.#liveStrokeBand = band;
  }

  public setPageHeight(height: number): void {
    this.pageSurface.setAttribute(
      "d",
      `M 0 0 L ${PAGE_WIDTH} 0 L ${PAGE_WIDTH} ${height} L 0 ${height} Z`,
    );
  }

  public setScheme(scheme: DocumentScheme): void {
    const palette = PORTABLE_PALETTE_V1[scheme];
    const properties = {
      "--inkbook-guide": palette.guide,
      "--inkbook-page": palette.page,
      "--inkbook-text": palette.text,
    };
    for (const [property, value] of Object.entries(properties)) {
      this.svg.style.setProperty(property, value);
    }
    this.svg.style.colorScheme = scheme;
  }

  public setBackgroundPaint(background: BackgroundV1, patternX: number, patternY: number): void {
    if (background.type === "none") {
      this.backgroundPath.setAttribute("fill", "none");
      this.setSquareBoundary(false);
      this.#backgroundPatternPath.setAttribute("d", "");
      return;
    }
    const spacing = String(background.spacing);
    this.#backgroundPattern.setAttribute("x", String(patternX));
    this.#backgroundPattern.setAttribute("y", String(patternY));
    this.#backgroundPattern.setAttribute("width", spacing);
    this.#backgroundPattern.setAttribute("height", spacing);
    this.#backgroundPatternPath.setAttribute("d", patternPath(background));
    this.#backgroundPatternPath.setAttribute(
      "stroke-linecap",
      background.type === "dots" ? "round" : "butt",
    );
    this.#backgroundPatternPath.setAttribute(
      "stroke-width",
      background.type === "dots" ? "2" : "1",
    );
    this.setSquareBoundary(background.type === "squares");
    this.backgroundPath.setAttribute("fill", `url(#${this.#backgroundPatternId})`);
  }

  public captureBackground(): void {
    this.cameraGroup.insertBefore(this.backgroundOutgoingPath, this.backgroundPath);
    copyAttributes(this.#backgroundPattern, this.#outgoingBackgroundPattern, [
      "x",
      "y",
      "width",
      "height",
    ]);
    copyAttributes(this.#backgroundPatternPath, this.#outgoingBackgroundPatternPath, [
      "d",
      "stroke-linecap",
      "stroke-width",
    ]);
    copyAttributes(this.backgroundPath, this.backgroundOutgoingPath, [
      "class",
      "stroke",
      "stroke-width",
      "vector-effect",
    ]);
    this.backgroundOutgoingPath.setAttribute("d", this.backgroundPath.getAttribute("d") ?? "");
    this.backgroundOutgoingPath.setAttribute(
      "fill",
      this.backgroundPath.getAttribute("fill") === "none"
        ? "none"
        : `url(#${this.#outgoingBackgroundPatternId})`,
    );
  }

  public clearCapturedBackground(): void {
    this.backgroundOutgoingPath.setAttribute("d", "");
    this.backgroundOutgoingPath.setAttribute("fill", "none");
    this.backgroundOutgoingPath.style.removeProperty("opacity");
    this.backgroundPath.style.removeProperty("opacity");
    this.cameraGroup.append(this.backgroundOutgoingPath);
  }

  public release(): void {
    for (const { listener, name } of this.#listeners) {
      this.inputSurface.removeEventListener(name, listener);
    }
    this.#listeners.length = 0;
    this.inputSurface.remove();
    this.svg.remove();
  }

  private createSvg<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
    return this.ownerDocument.createElementNS(SVG_NAMESPACE, name);
  }

  private setSquareBoundary(enabled: boolean): void {
    if (!enabled) {
      for (const attribute of ["class", "stroke", "stroke-width", "vector-effect"]) {
        this.backgroundPath.removeAttribute(attribute);
      }
      return;
    }
    this.backgroundPath.setAttribute("class", "inkbook-theme-guide");
    this.backgroundPath.setAttribute("stroke", PORTABLE_PALETTE_V1.light.guide);
    this.backgroundPath.setAttribute("stroke-width", "1");
    this.backgroundPath.setAttribute("vector-effect", "non-scaling-stroke");
  }

  private attachHandlers(handlers: SceneInputHandlers): void {
    for (const name of Object.keys(handlers) as InputEventName[]) {
      const handler = handlers[name];
      if (handler === undefined) continue;
      const listener = handler as EventListener;
      this.inputSurface.addEventListener(name, listener);
      this.#listeners.push({ listener, name });
    }
  }
}

function copyAttributes(source: Element, target: Element, names: readonly string[]): void {
  for (const name of names) {
    const value = source.getAttribute(name);
    if (value === null) target.removeAttribute(name);
    else target.setAttribute(name, value);
  }
}

function patternPath(background: Exclude<BackgroundV1, { type: "none" }>): string {
  const spacing = String(background.spacing);
  if (background.type === "dots") return "M 0 0 L 0 0";
  if (background.type === "lines") return `M 0 0 H ${spacing}`;
  return `M 0 0 H ${spacing} M 0 0 V ${spacing}`;
}
