export const ONBOARDING_COMPACT_HEIGHT = 400;

export interface OnboardingBounds {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export interface OnboardingLayoutInput {
  readonly paper: OnboardingBounds;
  readonly target: OnboardingBounds;
  readonly viewport: OnboardingBounds;
  readonly noteHeight: number;
  readonly navigationHeight?: number;
  readonly title?: OnboardingBounds;
  readonly targetVisible?: boolean;
  readonly compact?: boolean;
}

export interface OnboardingLayout {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly navigationLeft: number;
  readonly navigationTop: number;
  readonly arrow: string;
  readonly arrowHead: string;
  readonly visible: boolean;
  readonly navigationVisible: boolean;
  readonly showArrow: boolean;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(value, maximum));
}

export function onboardingNoteWidth(
  paper: OnboardingBounds,
  viewport: OnboardingBounds,
  compact: boolean,
): number {
  return Math.max(0, Math.min(compact ? 560 : 420, paper.width - 40, viewport.width - 32));
}

function containsBounds(outer: OnboardingBounds, inner: OnboardingBounds): boolean {
  return (
    inner.left >= outer.left &&
    inner.top >= outer.top &&
    inner.left + inner.width <= outer.left + outer.width &&
    inner.top + inner.height <= outer.top + outer.height
  );
}

function preferredNoteLeft(
  endX: number,
  title: OnboardingBounds,
  limits: { readonly min: number; readonly max: number; readonly width: number },
): number {
  const left = endX - title.left - title.width - 48;
  const right = endX + 48 - title.left;
  if (left >= limits.min && left <= limits.max) return left;
  if (right >= limits.min && right <= limits.max) return right;
  return endX - limits.width / 2;
}

function navigationPlacement(
  paper: OnboardingBounds,
  viewport: OnboardingBounds,
  height: number,
  compact: boolean,
) {
  const top =
    Math.min(viewport.top + viewport.height, paper.top + paper.height) -
    (compact ? 4 : 16) -
    height;
  return {
    left: paper.left + paper.width / 2,
    top,
    noteBottom: height > 0 ? top - (compact ? 4 : 24) : Infinity,
  };
}

function arrowPaths(
  note: OnboardingBounds,
  title: OnboardingBounds,
  endX: number,
  endY: number,
  limits: { readonly left: number; readonly right: number },
): {
  arrow: string;
  arrowHead: string;
} {
  const titleLeft = note.left + title.left;
  const pointsLeft = endX < titleLeft + title.width / 2;
  const startX = clamp(
    pointsLeft ? titleLeft - 6 : titleLeft + title.width + 6,
    limits.left,
    limits.right,
  );
  const startY = note.top + title.top + title.height / 2;
  const gap = startY - endY;
  const firstX = clamp(startX + (pointsLeft ? -36 : 36), limits.left, limits.right);
  const outward = Math.abs(firstX - startX);
  const firstY = Math.max(
    endY + 12,
    Math.min(startY - Math.max(0, 36 - outward) * 2, note.top + title.top - title.height),
  );
  const secondX = endX;
  const secondY = endY + gap * 0.45;
  const length = Math.hypot(endX - secondX, endY - secondY);
  const directionX = (endX - secondX) / length;
  const directionY = (endY - secondY) / length;
  const baseX = endX - directionX * 10;
  const baseY = endY - directionY * 10;
  return {
    arrow: `M ${startX} ${startY} C ${firstX} ${firstY} ${secondX} ${secondY} ${endX} ${endY}`,
    arrowHead: `M ${baseX - directionY * 4.5} ${baseY + directionX * 4.5} L ${endX} ${endY} L ${baseX + directionY * 4.5} ${baseY - directionX * 4.5}`,
  };
}

export function layoutOnboardingNote({
  paper,
  target,
  viewport,
  noteHeight,
  navigationHeight = 0,
  title: measuredTitle,
  targetVisible = true,
  compact = false,
}: OnboardingLayoutInput): OnboardingLayout {
  const width = onboardingNoteWidth(paper, viewport, compact);
  const viewportRight = viewport.left + viewport.width;
  const viewportBottom = viewport.top + viewport.height;
  const minLeft = Math.max(viewport.left + 16, paper.left + 16);
  const maxLeft = Math.min(viewportRight - 16 - width, paper.left + paper.width - 16 - width);
  const title = measuredTitle ?? { left: width * 0.08, top: 12, width: width * 0.84, height: 30 };
  const endX = target.left + target.width / 2;
  const preferredLeft = preferredNoteLeft(endX, title, { min: minLeft, max: maxLeft, width });
  const left = clamp(preferredLeft, minLeft, Math.max(minLeft, maxLeft));
  const minTop = Math.max(viewport.top, paper.top) + (compact ? 4 : 8);
  const navigation = navigationPlacement(paper, viewport, navigationHeight, compact);
  const maxTop = Math.min(
    viewportBottom - 8 - noteHeight,
    paper.top + paper.height - 8 - noteHeight,
    navigation.noteBottom - noteHeight,
  );
  const endY = minTop + (compact ? 0 : 8);
  const preferredTop = endY + (compact ? 32 : 80);
  const top = clamp(preferredTop, minTop, Math.max(minTop, maxTop));
  const visible = width > 0 && noteHeight >= 0 && maxLeft >= minLeft && maxTop >= minTop;
  const navigationVisible = width > 0 && maxLeft >= minLeft && navigation.top >= minTop;
  const showArrow =
    visible &&
    targetVisible &&
    containsBounds(viewport, target) &&
    target.left + target.width / 2 >= minLeft &&
    target.left + target.width / 2 <= paper.left + paper.width - 16 &&
    top + title.top + title.height / 2 - endY >= (compact ? 8 : title.height + 32);
  return {
    left,
    top,
    width,
    navigationLeft: navigation.left,
    navigationTop: navigation.top,
    ...(showArrow
      ? arrowPaths({ left, top, width, height: noteHeight }, title, endX, endY, {
          left: Math.max(paper.left, viewport.left) + 12,
          right: Math.min(paper.left + paper.width, viewportRight) - 12,
        })
      : { arrow: "", arrowHead: "" }),
    visible,
    navigationVisible,
    showArrow,
  };
}
