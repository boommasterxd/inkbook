import { parseCanonicalSvgDecimal } from "./svg-number";

const CURRENT_DOCUMENT_VERSION = 1;
const OLDEST_EDITABLE_DOCUMENT_VERSION = 0;
const SHA256 = /^[0-9a-f]{64}$/u;
const ROOT_ATTRIBUTES = new Set([
  "xmlns",
  "viewBox",
  "data-inkbook-format",
  "data-inkbook-version",
  "data-inkbook-revision",
  "data-inkbook-snapshot-sha256",
  "width",
  "height",
]);

export type SafeSvgVersionPolicy = "current" | "editable" | "newer";

export interface SafeSvgRoot {
  readonly height: number;
  readonly revision: number;
  readonly snapshotHash: string | null;
  readonly version: number;
}

interface RootTag {
  readonly attributes: ReadonlyMap<string, string>;
  readonly name: string;
  readonly selfClosing: boolean;
}

export function parseSafeSvgRoot(
  tag: RootTag,
  versionPolicy: SafeSvgVersionPolicy,
): SafeSvgRoot | null {
  if (!hasRootIdentity(tag)) return null;
  const viewBox = tag.attributes.get("viewBox")?.split(" ");
  if (!hasCanonicalViewBox(viewBox)) return null;
  const height = parseCanonicalSvgDecimal(viewBox[3], 1_000_000);
  const revision = parseCanonicalSvgDecimal(
    tag.attributes.get("data-inkbook-revision"),
    Number.MAX_SAFE_INTEGER,
  );
  const version = parseCanonicalSvgDecimal(
    tag.attributes.get("data-inkbook-version"),
    Number.MAX_SAFE_INTEGER,
  );
  const snapshotHash = tag.attributes.get("data-inkbook-snapshot-sha256");
  return height !== null &&
    height > 0 &&
    revision !== null &&
    Number.isSafeInteger(revision) &&
    versionMatches(version, versionPolicy) &&
    hashMatchesVersion(snapshotHash, version) &&
    optionalDimensionsMatch(tag.attributes, height)
    ? { height, revision, snapshotHash: snapshotHash ?? null, version }
    : null;
}

function hashMatchesVersion(value: string | undefined, version: number | null): boolean {
  if (version === 0) return value === undefined;
  return version !== null && version >= 1 && value !== undefined && SHA256.test(value);
}

function hasRootIdentity(tag: RootTag): boolean {
  return (
    tag.name === "svg" &&
    !tag.selfClosing &&
    [...tag.attributes.keys()].every((name) => ROOT_ATTRIBUTES.has(name)) &&
    tag.attributes.get("xmlns") === "http://www.w3.org/2000/svg" &&
    tag.attributes.get("data-inkbook-format") === "inkbook"
  );
}

function hasCanonicalViewBox(viewBox: string[] | undefined): viewBox is string[] {
  return (
    viewBox?.length === 4 && viewBox[0] === "0" && viewBox[1] === "0" && viewBox[2] === "2048.6"
  );
}

function versionMatches(version: number | null, policy: SafeSvgVersionPolicy): version is number {
  if (version === null || !Number.isSafeInteger(version)) return false;
  if (policy === "current") return version === CURRENT_DOCUMENT_VERSION;
  if (policy === "editable") {
    return version >= OLDEST_EDITABLE_DOCUMENT_VERSION && version <= CURRENT_DOCUMENT_VERSION;
  }
  return version > CURRENT_DOCUMENT_VERSION;
}

function optionalDimensionsMatch(attributes: ReadonlyMap<string, string>, height: number): boolean {
  const widthAttribute = attributes.get("width");
  const heightAttribute = attributes.get("height");
  return (
    (widthAttribute === undefined || widthAttribute === "2048.6") &&
    (heightAttribute === undefined ||
      parseCanonicalSvgDecimal(heightAttribute, 1_000_000) === height)
  );
}
