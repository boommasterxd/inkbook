import type { ImageCropV3, ImageResourceV3 } from "../../domain/schema/public";

export type ImageCropEdge = "left" | "top" | "right" | "bottom";

/** Source-pixel draft only; the editor applies the confirmed crop through its command history. */
export class ImageCropDraft {
  public crop: ImageCropV3;

  public constructor(
    private readonly resource: Pick<ImageResourceV3, "width" | "height">,
    crop: ImageCropV3,
  ) {
    this.crop = { ...crop };
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
    const clamp = (minimum: number, maximum: number): number =>
      Math.max(minimum, Math.min(maximum, value));
    if (edge === "left")
      this.crop = { ...this.crop, x: clamp(0, right - 1), width: right - clamp(0, right - 1) };
    if (edge === "top")
      this.crop = { ...this.crop, y: clamp(0, bottom - 1), height: bottom - clamp(0, bottom - 1) };
    if (edge === "right")
      this.crop = { ...this.crop, width: clamp(left + 1, this.resource.width) - left };
    if (edge === "bottom")
      this.crop = { ...this.crop, height: clamp(top + 1, this.resource.height) - top };
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
