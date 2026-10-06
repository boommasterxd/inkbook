import { roundCanonical } from "../../domain/geometry/public";
import { PAGE_WIDTH, PORTABLE_PALETTE_V1, type BackgroundV1 } from "../../domain/schema/public";
import type { RenderBand } from "../../domain/commands/render-bands";
import { createToolCursorDom, type SceneToolCursorDom } from "./tool-cursor";
import { SVG_NAMESPACE } from "./constants";
import type { DocumentScheme, SceneInputHandlers, SceneRendererOptions } from "./types";
import { SceneSurface } from "./scene-surface";
import { SCENE_SURFACE_STYLES } from "./scene-surface-styles";

type InputEventName = keyof SceneInputHandlers;
type SurfaceOptions = Pick<SceneRendererOptions, "surfaceThemeRoot" | "onSurfaceFailure">;
type SceneDomOptions = Pick<
  SceneRendererOptions,
  "container" | "accessibleName" | "inputHandlers" | "surfaceThemeRoot" | "onSurfaceFailure"
>;

let nextBackgroundPatternId = 0;

export class SceneDom {
  public onSurfaceInvalidated: () => void = () => undefined;
  public readonly backgroundEdgePath: SVGPathElement;
  public readonly backgroundPath: SVGPathElement;
  public readonly cameraGroup: SVGGElement;
  public readonly contentGroup: SVGGElement;
  public readonly highlightGroup: SVGGElement;
  public readonly inputSurface: HTMLDivElement;
  public readonly liveGroup: SVGGElement;
  public readonly liveStrokeGroup: SVGGElement;
  public livePath: SVGPathElement;
  public readonly motionGroup: SVGGElement;
  public readonly overlayPath: SVGPathElement;
  public readonly selectionTraceGroup: SVGGElement;
  public readonly selectionOverlayPath: SVGPathElement;
  public readonly selectionHandlePath: SVGPathElement;
  public readonly snapMarkerPath: SVGPathElement;
  public readonly ownerDocument: Document;
  public readonly pageSurface: SVGPathElement;
  public readonly svg: SVGSVGElement;
  public readonly toolCursor: SceneToolCursorDom;
  readonly #backgroundPattern: SVGPatternElement;
  readonly #backgroundPatternPath: SVGPathElement;
  readonly #backgroundPatternId: string;
  #livePathBand: RenderBand = "content";
  #liveStrokeBand: RenderBand = "content";
  readonly #listeners: { name: InputEventName; listener: EventListener }[] = [];
  readonly #surface: SceneSurface;

  public static create(options: SceneDomOptions): SceneDom {
    return new SceneDom(
      options.container,
      options.accessibleName ?? "Inkbook canvas",
      options.inputHandlers ?? {},
      options,
    );
  }

  public constructor(
    container: HTMLElement,
    accessibleName: string,
    handlers: SceneInputHandlers,
    options: SurfaceOptions = {},
  ) {
    this.#surface = this.createSurface(container, options);
    this.ownerDocument = this.#surface.drawingDocument;
    this.svg = this.createSvg("svg");
    this.toolCursor = createToolCursorDom(container.ownerDocument);
    this.cameraGroup = this.createSvg("g");
    this.pageSurface = this.createSvg("path");
    this.backgroundPath = this.createSvg("path");
    this.backgroundEdgePath = this.createSvg("path");
    this.#backgroundPattern = this.createSvg("pattern");
    this.#backgroundPatternPath = this.createSvg("path");
    nextBackgroundPatternId += 1;
    this.#backgroundPatternId = `inkbook-background-pattern-${String(nextBackgroundPatternId)}`;
    this.highlightGroup = this.createSvg("g");
    this.contentGroup = this.createSvg("g");
    this.motionGroup = this.createSvg("g");
    this.liveGroup = this.createSvg("g");
    this.livePath = this.createSvg("path");
    this.liveStrokeGroup = this.createSvg("g");
    const overlayGroup = this.createSvg("g");
    this.overlayPath = this.createSvg("path");
    this.selectionTraceGroup = this.createSvg("g");
    this.selectionOverlayPath = this.createSvg("path");
    this.selectionHandlePath = this.createSvg("path");
    this.snapMarkerPath = this.createSvg("path");
    const themeStyle = this.createSvg("style");
    this.inputSurface = container.ownerDocument.createElementNS(
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
    this.backgroundEdgePath.setAttribute("class", "inkbook-theme-guide");
    this.backgroundEdgePath.setAttribute("fill", "none");
    this.backgroundEdgePath.setAttribute("pointer-events", "none");
    this.#backgroundPattern.setAttribute("id", this.#backgroundPatternId);
    this.#backgroundPattern.setAttribute("patternUnits", "userSpaceOnUse");
    this.#backgroundPatternPath.setAttribute("class", "inkbook-theme-guide");
    this.#backgroundPatternPath.setAttribute("fill", "none");
    this.#backgroundPatternPath.setAttribute("stroke", PORTABLE_PALETTE_V1.light.guide);
    this.#backgroundPattern.append(this.#backgroundPatternPath);
    this.highlightGroup.setAttribute("pointer-events", "none");
    this.highlightGroup.setAttribute("class", "inkbook-scene-highlights inkbook-scene-foreground");
    this.contentGroup.setAttribute("pointer-events", "none");
    this.contentGroup.setAttribute("class", "inkbook-scene-content inkbook-scene-foreground");
    this.motionGroup.setAttribute("aria-hidden", "true");
    this.motionGroup.setAttribute("class", "inkbook-scene-motion inkbook-scene-foreground");
    this.motionGroup.setAttribute("pointer-events", "none");
    this.liveGroup.setAttribute("class", "inkbook-scene-foreground");
    this.liveGroup.setAttribute("pointer-events", "none");
    this.liveStrokeGroup.setAttribute("class", "inkbook-scene-foreground");
    this.liveStrokeGroup.setAttribute("pointer-events", "none");
    overlayGroup.setAttribute("pointer-events", "none");
    overlayGroup.setAttribute("class", "inkbook-scene-overlays inkbook-scene-foreground");
    this.livePath.setAttribute("pointer-events", "none");
    this.configureSelectionOverlays();
    themeStyle.textContent = SCENE_SURFACE_STYLES;

    this.cameraGroup.append(
      this.pageSurface,
      this.backgroundPath,
      this.backgroundEdgePath,
      this.highlightGroup,
      this.contentGroup,
      this.liveGroup,
      this.liveStrokeGroup,
      this.motionGroup,
      this.selectionTraceGroup,
    );
    this.liveGroup.append(this.livePath);
    overlayGroup.append(
      this.overlayPath,
      this.selectionOverlayPath,
      this.selectionHandlePath,
      this.snapMarkerPath,
    );
    const defs = this.createSvg("defs");
    defs.append(this.#backgroundPattern);
    this.svg.append(themeStyle, this.cameraGroup, overlayGroup, defs);

    this.configureInputSurface(accessibleName);
    this.svg.setAttribute("height", "100%");
    this.svg.setAttribute("width", "100%");
    this.svg.setAttribute("pointer-events", "none");

    this.attachHandlers(handlers);
    this.#surface.attach(this.svg);
    container.append(this.inputSurface);
    this.setPageHeight(1);
  }

  public readSurface(): void {
    this.#surface.read();
  }

  public setZoomBlockSize(blockSize: number): void {
    this.#surface.setZoomBlockSize(blockSize);
  }

  public writeSurface(): void {
    this.#surface.write();
  }

  public invalidateSurfaceTheme(): void {
    this.#surface.invalidateTheme();
  }

  public revealSurface(): void {
    this.#surface.reveal();
  }

  public replaceLivePath(): void {
    this.livePath = this.createSvg("path");
    this.livePath.setAttribute("pointer-events", "none");
    this.liveGroup.append(this.livePath);
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
      this.cameraGroup.insertBefore(group, this.motionGroup);
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
      this.toolCursor.surface.style.setProperty(property, value);
    }
    this.svg.style.colorScheme = scheme;
  }

  public setBackgroundPaint(
    background: BackgroundV1,
    paint: "none" | "pattern",
    patternX: number,
    patternY: number,
    zoom: number,
  ): void {
    if (paint === "none" || background.type === "none") {
      this.backgroundPath.setAttribute("fill", "none");
      this.#backgroundPatternPath.setAttribute("d", "");
      return;
    }
    const strokeWidth = background.type === "dots" ? 2 : 1;
    const inset = roundCanonical(strokeWidth / (2 * zoom));
    const spacing = String(background.spacing);
    const originX = background.type === "lines" ? patternX : patternX - inset;
    this.#backgroundPattern.setAttribute("x", String(roundCanonical(originX)));
    this.#backgroundPattern.setAttribute("y", String(roundCanonical(patternY - inset)));
    this.#backgroundPattern.setAttribute("width", spacing);
    this.#backgroundPattern.setAttribute("height", spacing);
    this.#backgroundPatternPath.setAttribute("d", patternPath(background, inset));
    this.#backgroundPatternPath.setAttribute(
      "stroke-linecap",
      background.type === "dots" ? "round" : "butt",
    );
    this.#backgroundPatternPath.setAttribute(
      "stroke-width",
      String(roundCanonical(strokeWidth / zoom)),
    );
    this.backgroundEdgePath.setAttribute(
      "stroke-linecap",
      background.type === "dots" ? "round" : "butt",
    );
    this.backgroundEdgePath.setAttribute(
      "stroke-width",
      String(roundCanonical(strokeWidth / zoom)),
    );
    if (background.type === "dots") {
      this.backgroundEdgePath.setAttribute("stroke-dasharray", `0 ${spacing}`);
    } else {
      this.backgroundEdgePath.removeAttribute("stroke-dasharray");
    }
    this.backgroundPath.setAttribute("fill", `url(#${this.#backgroundPatternId})`);
  }

  public release(): void {
    this.releaseInputSurface();
    this.#surface.release();
  }

  private releaseInputSurface(): void {
    this.inputSurface.setAttribute("inert", "");
    this.inputSurface.tabIndex = -1;
    for (const { listener, name } of this.#listeners) {
      this.inputSurface.removeEventListener(name, listener);
    }
    this.#listeners.length = 0;
    this.inputSurface.remove();
  }

  private createSurface(container: HTMLElement, options: SurfaceOptions): SceneSurface {
    const onFailure = options.onSurfaceFailure;
    return new SceneSurface(container, () => this.onSurfaceInvalidated(), {
      ...(options.surfaceThemeRoot === undefined ? {} : { themeRoot: options.surfaceThemeRoot }),
      onFailure: () => {
        this.releaseInputSurface();
        onFailure?.();
      },
    });
  }

  private configureSelectionOverlays(): void {
    this.overlayPath.setAttribute("class", "inkbook-selection-area-preview");
    this.overlayPath.setAttribute("fill-rule", "evenodd");
    this.selectionTraceGroup.setAttribute(
      "class",
      "inkbook-selection-traces inkbook-scene-foreground",
    );
    this.selectionTraceGroup.setAttribute("pointer-events", "none");
    this.selectionOverlayPath.setAttribute("class", "inkbook-selection-overlay");
    this.selectionOverlayPath.setAttribute("data-selection-fill", "accent");
    this.selectionHandlePath.setAttribute("class", "inkbook-selection-handles");
    this.snapMarkerPath.setAttribute("class", "inkbook-snap-guide");
    this.snapMarkerPath.setAttribute("pointer-events", "none");
  }

  private createSvg<K extends keyof SVGElementTagNameMap>(name: K): SVGElementTagNameMap[K] {
    return this.ownerDocument.createElementNS(SVG_NAMESPACE, name);
  }

  private configureInputSurface(accessibleName: string): void {
    const label = this.inputSurface.ownerDocument.createElementNS(
      "http://www.w3.org/1999/xhtml",
      "span",
    );
    const labelId = `${this.#backgroundPatternId}-input-label`;
    label.setAttribute("id", labelId);
    label.setAttribute("hidden", "");
    label.textContent = accessibleName;
    this.inputSurface.append(label);
    this.inputSurface.tabIndex = 0;
    this.inputSurface.setAttribute("class", "inkbook-canvas-input");
    // Obsidian turns aria-label into a hover tooltip, even on the canvas.
    this.inputSurface.setAttribute("aria-labelledby", labelId);
    this.inputSurface.setAttribute("role", "application");
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

function patternPath(background: Exclude<BackgroundV1, { type: "none" }>, inset: number): string {
  const spacing = String(background.spacing);
  const offset = String(inset);
  if (background.type === "dots") return `M ${offset} ${offset} L ${offset} ${offset}`;
  if (background.type === "lines") return `M 0 ${offset} H ${spacing}`;
  return `M 0 ${offset} H ${spacing} M ${offset} 0 V ${spacing}`;
}
