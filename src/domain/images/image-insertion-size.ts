import type { ImageElementV3, ImageResourceV3 } from "../schema/types";

/** Keep standalone images compact while PDF pages retain their writing-width placement. */
export function initialImageSize(
  resource: Pick<ImageResourceV3, "width" | "height">,
  writingWidth: number,
  source: "image" | "pdf",
): Pick<ImageElementV3, "width" | "height"> {
  if (source === "pdf") {
    const width = Math.min(resource.width, writingWidth);
    return { width, height: (width * resource.height) / resource.width };
  }
  const extent = writingWidth * 0.4;
  const scale = Math.min(1, extent / resource.width, extent / resource.height);
  return { width: resource.width * scale, height: resource.height * scale };
}
