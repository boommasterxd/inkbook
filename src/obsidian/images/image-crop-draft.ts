import type { ImageCropV3, ImageResourceV3 } from "../../domain/schema/public";

export type ImageCropEdge = "left" | "top" | "right" | "bottom";

/** Source-pixel draft only; the editor applies the confirmed crop through its command history. */
export class ImageCropDraft {
  public crop: ImageCropV3;
  readonly #minimum: Pick<ImageCropV3, "width" | "height">;

  public constructor(
    private readonly resource: Pick<ImageResourceV3, "width" | "height">,
    crop: ImageCropV3,
    pageSize: Pick<ImageCropV3, "width" | "height"> = crop,
  ) {
    this.crop = { ...crop };
    // Keep at least one page-space geometry quantum after three-decimal rounding.
    this.#minimum = {
      width: Math.min(
        resource.width,
        Math.max(1, Math.ceil((crop.width * 0.001) / pageSize.width)),
      ),
      height: Math.min(
        resource.height,
        Math.max(1, Math.ceil((crop.height * 0.001) / pageSize.height)),
      ),
    };
  }

  public edge(edge: ImageCropEdge): number {
    if (edge === "left") return this.crop.x;
    if (edge === "top") return this.crop.y;
    return edge === "right" ? this.crop.x + this.crop.width : this.crop.y + this.crop.height;
  }

  public set(edge: ImageCropEdge, value: number): void {
    if (!Number.isFinite(value)) return;
    const left = this.edge("left");
    const top = this.edge("top");
    const right = this.edge("right");
    const bottom = this.edge("bottom");
    const minimum = this.#minimum;
    const clamp = (minimum: number, maximum: number): number =>
      Math.max(minimum, Math.min(maximum, value));
    if (edge === "left")
      this.crop = {
        ...this.crop,
        x: clamp(0, right - minimum.width),
        width: right - clamp(0, right - minimum.width),
      };
    if (edge === "top")
      this.crop = {
        ...this.crop,
        y: clamp(0, bottom - minimum.height),
        height: bottom - clamp(0, bottom - minimum.height),
      };
    if (edge === "right")
      this.crop = { ...this.crop, width: clamp(left + minimum.width, this.resource.width) - left };
    if (edge === "bottom")
      this.crop = { ...this.crop, height: clamp(top + minimum.height, this.resource.height) - top };
  }

  public reset(): void {
    this.crop = { x: 0, y: 0, width: this.resource.width, height: this.resource.height };
  }

  public move(dx: number, dy: number): void {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return;
    this.crop = {
      ...this.crop,
      x: Math.max(0, Math.min(this.resource.width - this.crop.width, this.crop.x + dx)),
      y: Math.max(0, Math.min(this.resource.height - this.crop.height, this.crop.y + dy)),
    };
  }

  public replace(crop: ImageCropV3): void {
    this.crop = { ...crop };
  }
}
