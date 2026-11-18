import { canonicalizeGeometryNumber } from "../schema/canonical";
import type { ImageElementV3, ImageResourceV3, PageV1 } from "../schema/types";

export type ImageInsertionPlacement = "default" | "page-width-locked";

/** Both the review sheet and the document use the same writing-area bounds. */
export function initialImageX(
  width: number,
  page: Pick<PageV1, "margin" | "innerWidth">,
  centerX: number,
  placement: ImageInsertionPlacement = "default",
): number {
  if (placement === "page-width-locked") return page.margin;
  return canonicalizeGeometryNumber(
    Math.max(page.margin, Math.min(centerX - width / 2, page.margin + page.innerWidth - width)),
  );
}

/** Keep standalone images compact while PDF pages retain their writing-width placement. */
export function initialImageSize(
  resource: Pick<ImageResourceV3, "width" | "height">,
  writingWidth: number,
  source: "image" | "pdf",
  placement: ImageInsertionPlacement = "default",
): Pick<ImageElementV3, "width" | "height"> {
  if (placement === "page-width-locked") {
    return { width: writingWidth, height: (writingWidth * resource.height) / resource.width };
  }
  if (source === "pdf") {
    const width = Math.min(resource.width, writingWidth);
    return { width, height: (width * resource.height) / resource.width };
  }
  const extent = writingWidth * 0.4;
  const scale = Math.min(1, extent / resource.width, extent / resource.height);
  return { width: resource.width * scale, height: resource.height * scale };
}
