import {
  validateDashArray,
  validatePathDataSteps,
  type PathValidationStepOptions,
} from "./path-data-validator";
import {
  DOCUMENT_PALETTE,
  DOCUMENT_THEME_FALLBACK,
  THEME_CLASSES,
  type ThemeClass,
} from "./svg-theme";
import { parseCanonicalSvgDecimal, parseCanonicalSvgOpacity } from "./svg-number";
import { isSafeSvgPathTransform } from "./safe-svg-transform";
const RGBA = /^#[0-9A-F]{8}$/u;
const PATH_ATTRIBUTES = new Set([
  "class",
  "d",
  "fill",
  "fill-opacity",
  "fill-rule",
  "stroke",
  "stroke-dasharray",
  "stroke-linecap",
  "stroke-linejoin",
  "stroke-opacity",
  "stroke-width",
  "transform",
]);

function validatePaint(value: string | undefined): boolean {
  return value === undefined || value === "none" || RGBA.test(value);
}

function optionalMember(value: string | undefined, allowed: readonly string[]): boolean {
  return value === undefined || allowed.includes(value);
}

function validateOptionalDecimals(attributes: ReadonlyMap<string, string>): boolean {
  const opacityValid = ["fill-opacity", "stroke-opacity"].every((name) => {
    const value = attributes.get(name);
    return value === undefined || parseCanonicalSvgOpacity(value) !== null;
  });
  const width = attributes.get("stroke-width");
  return opacityValid && (width === undefined || parseCanonicalSvgDecimal(width, 256) !== null);
}

export function* validatePathAttributesSteps(
  attributes: ReadonlyMap<string, string>,
  deadlineExceeded?: () => boolean,
  observeCommand?: PathValidationStepOptions["observeCommand"],
  version = 1,
): Generator<void, number | null> {
  if (
    attributes.size === 0 ||
    [...attributes.keys()].some((name) => !PATH_ATTRIBUTES.has(name)) ||
    !validatePaint(attributes.get("fill")) ||
    !validatePaint(attributes.get("stroke"))
  ) {
    return null;
  }
  const transform = attributes.get("transform");
  if (transform !== undefined && (version < 2 || !isSafeSvgPathTransform(transform))) return null;
  const pathData = attributes.get("d");
  const pathResult =
    pathData === undefined
      ? null
      : yield* validatePathDataSteps(pathData, {
          ...(deadlineExceeded === undefined ? {} : { deadlineExceeded }),
          ...(observeCommand === undefined ? {} : { observeCommand }),
        });
  if (pathResult === null) {
    return null;
  }
  if (!validateClass(attributes)) return null;
  if (
    !optionalMember(attributes.get("fill-rule"), ["nonzero", "evenodd"]) ||
    !optionalMember(attributes.get("stroke-linecap"), ["butt", "round", "square"]) ||
    !optionalMember(attributes.get("stroke-linejoin"), ["miter", "round", "bevel"]) ||
    !validateOptionalDecimals(attributes)
  ) {
    return null;
  }
  const dash = attributes.get("stroke-dasharray");
  return dash !== undefined && !validateDashArray(dash) ? null : pathResult.commands;
}

function validateClass(attributes: ReadonlyMap<string, string>): boolean {
  const className = attributes.get("class");
  return (
    className === undefined ||
    (THEME_CLASSES.some((entry) => entry === className) &&
      validateThemeFallback(attributes, className as ThemeClass))
  );
}

function validateThemeFallback(
  attributes: ReadonlyMap<string, string>,
  className: ThemeClass,
): boolean {
  const text = DOCUMENT_PALETTE.light.text;
  switch (className) {
    case "inkbook-theme-page":
      return attributes.get("fill") === DOCUMENT_PALETTE.light.page;
    case "inkbook-theme-guide":
      return attributes.get("stroke") === DOCUMENT_THEME_FALLBACK.guide;
    case "inkbook-theme-stroke":
      return attributes.get("stroke") === text;
    case "inkbook-theme-fill":
      return attributes.get("fill") === text;
    case "inkbook-theme-stroke-fill":
      return attributes.get("stroke") === text && attributes.get("fill") === text;
  }
}
