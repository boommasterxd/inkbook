import { roundCanonical } from "./primitives";
import type { BackgroundV1 } from "../schema/types";

export interface GuideAxis {
  readonly end: number;
  readonly intervalCount: number;
  readonly start: number;
}

export interface BackgroundGuideLayout {
  readonly bottom: number;
  readonly horizontal: GuideAxis;
  readonly horizontalPointCount: number;
  readonly horizontalSpacing: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly vertical: GuideAxis;
  readonly verticalPointCount: number;
  readonly verticalSpacing: number;
}

export interface BackgroundGuideLayoutRequest {
  readonly background: Exclude<BackgroundV1, { type: "none" }>;
  readonly innerWidth: number;
  readonly margin: number;
  readonly pageHeight: number;
}

export function centeredGuideAxis(
  availableStart: number,
  availableLength: number,
  spacing: number,
): GuideAxis {
  return guideAxis(availableStart, availableLength, spacing, "centered");
}

export function topAnchoredGuideAxis(
  availableStart: number,
  availableLength: number,
  spacing: number,
): GuideAxis {
  return guideAxis(availableStart, availableLength, spacing, "start");
}

function guideAxis(
  availableStart: number,
  availableLength: number,
  spacing: number,
  alignment: "centered" | "start",
): GuideAxis {
  const boundedLength = roundCanonical(Math.max(0, availableLength));
  const intervalCount = completeIntervalCount(boundedLength, spacing);
  const coveredLength = intervalCount * spacing;
  const offset = alignment === "centered" ? (boundedLength - coveredLength) / 2 : 0;
  const start = roundCanonical(availableStart + offset);
  return {
    end: roundCanonical(start + coveredLength),
    intervalCount,
    start,
  };
}

export function backgroundGuideLayout(
  request: BackgroundGuideLayoutRequest,
): BackgroundGuideLayout {
  const { background, innerWidth, margin, pageHeight } = request;
  const horizontalSpacing = frameSpacing(background);
  const horizontal = fixedFrameGuideAxis(margin, innerWidth, horizontalSpacing);
  const vertical = fixedFrameGuideAxis(
    margin,
    Math.max(0, pageHeight - 2 * margin),
    background.spacing,
  );
  return {
    bottom: vertical.end,
    horizontal,
    horizontalPointCount:
      background.type === "lines" ? 0 : guidePointCount(horizontal, horizontalSpacing),
    horizontalSpacing,
    left: horizontal.start,
    right: horizontal.end,
    top: vertical.start,
    vertical,
    verticalPointCount: guidePointCount(vertical, background.spacing),
    verticalSpacing: background.spacing,
  };
}

function fixedFrameGuideAxis(start: number, length: number, spacing: number): GuideAxis {
  const boundedLength = roundCanonical(Math.max(0, length));
  return {
    end: roundCanonical(start + boundedLength),
    intervalCount: completeIntervalCount(boundedLength, spacing),
    start: roundCanonical(start),
  };
}

function completeIntervalCount(length: number, spacing: number): number {
  const quotient = length / spacing;
  const nearestInteger = Math.round(quotient);
  return Math.max(
    0,
    Math.abs(quotient - nearestInteger) <= Number.EPSILON * Math.max(1, Math.abs(quotient)) * 4
      ? nearestInteger
      : Math.floor(quotient),
  );
}

function guidePointCount(axis: GuideAxis, spacing: number): number {
  const periodicEnd = roundCanonical(axis.start + axis.intervalCount * spacing);
  return axis.intervalCount + 1 + (periodicEnd === axis.end ? 0 : 1);
}

function frameSpacing(background: Exclude<BackgroundV1, { type: "none" }>): number {
  return background.spacing;
}
