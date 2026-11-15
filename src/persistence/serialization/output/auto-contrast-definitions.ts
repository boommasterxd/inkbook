import type { ImageElementV3, InkSnapshotV1 } from "../../../domain/schema/public";
import { DOCUMENT_PALETTE } from "../../documents/svg-theme";
import { serializeSvgNumber as number } from "../../documents/svg-number";
import { serializeImageMarkup } from "./image-markup";
import { AUTO_CONTRAST_MATRIX } from "../../../domain/images/auto-contrast";

export function autoContrastFilterMarkup(id: string, tileAttributes: string): string {
  return `<filter id="${id}" ${tileAttributes} filterUnits="userSpaceOnUse" color-interpolation-filters="linearRGB"><feColorMatrix type="matrix" values="${AUTO_CONTRAST_MATRIX}"/><feComponentTransfer><feFuncR type="discrete" tableValues="0 1"/><feFuncG type="discrete" tableValues="0 1"/><feFuncB type="discrete" tableValues="0 1"/></feComponentTransfer></filter>`;
}

export function usesAutoImagePresentation(
  snapshot: InkSnapshotV1 | undefined,
  images?: readonly ImageElementV3[],
): snapshot is InkSnapshotV1 {
  return (
    snapshot !== undefined &&
    snapshot.version >= 5 &&
    (images?.length ?? snapshot.imageResources?.length ?? 0) > 0
  );
}

/** The contrast input deliberately excludes guides, highlighters and annotations. */
export function* autoDefinitionsFragments(
  snapshot: InkSnapshotV1 | undefined,
  lockedHeight: number,
  images?: readonly ImageElementV3[],
): Iterable<string> {
  if (!usesAutoImagePresentation(snapshot, images)) return;
  const height = number(lockedHeight);
  yield `<defs id="inkbook-auto"><svg id="inkbook-auto-underlay" x="0" y="0" width="2048.6" height="${height}" viewBox="0 0 2048.6 ${height}" overflow="hidden" preserveAspectRatio="none">`;
  yield `<path d="M 0 0 L 2048.6 0 L 2048.6 ${height} L 0 ${height} Z" class="inkbook-theme-page" fill="${DOCUMENT_PALETTE.light.page}"/>`;
  if (images !== undefined) {
    for (const image of images) yield serializeUnderlayImage(image);
  } else {
    for (let index = 0; index < snapshot.elements.length; index += 1) {
      const element = snapshot.elements[index]!;
      if (element.kind === "image") yield serializeUnderlayImage(element);
      else if ((index + 1) % 256 === 0) yield "";
    }
  }
  yield "</svg></defs>";
}

function serializeUnderlayImage(image: ImageElementV3): string {
  const markup = serializeImageMarkup(image);
  if (image.contrast === undefined) return markup;
  const crop = image.crop;
  const fill = image.contrast === "light" ? "#FFFFFFFF" : "#000000FF";
  return markup.replace(
    `<use href="#inkbook-image-${image.assetId}"/>`,
    `<rect x="${number(crop.x)}" y="${number(crop.y)}" width="${number(crop.width)}" height="${number(crop.height)}" fill="${fill}"/>`,
  );
}
