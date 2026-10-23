export interface ChromeColors {
  readonly accent: string;
  readonly danger: string;
  readonly faint: string;
  readonly muted: string;
  readonly activeBackground: string;
  readonly activeBorder: string;
  readonly dangerHover: string;
  readonly hover: string;
}

export const CHROME_TRANSPARENT = "rgba(0, 0, 0, 0)";

export function sameChromeColors(
  previous: ChromeColors | undefined,
  next: ChromeColors | undefined,
): boolean {
  if (previous === undefined || next === undefined) return previous === next;
  return (Object.keys(previous) as Array<keyof ChromeColors>).every(
    (name) => previous[name] === next[name],
  );
}

/** Resolve nested host tokens to concrete paint values in the owning document. */
export function createChromePalette(element: HTMLElement) {
  const probes = {
    accent: "var(--interactive-accent)",
    danger: "var(--text-error)",
    faint: "var(--text-faint)",
    muted: "var(--text-muted)",
    activeBackground: "color-mix(in srgb, var(--interactive-accent) 14%, transparent)",
    activeBorder: "color-mix(in srgb, var(--interactive-accent) 45%, transparent)",
    dangerHover: "color-mix(in srgb, var(--text-error) 12%, transparent)",
    hover: "var(--background-modifier-hover)",
  };
  const container = element.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "span");
  container.hidden = true;
  container.setAttribute("aria-hidden", "true");
  const samples = Object.entries(probes).map(([name, color]) => {
    const sample = element.ownerDocument.createElementNS("http://www.w3.org/1999/xhtml", "span");
    sample.style.color = color;
    container.append(sample);
    return [name, sample] as const;
  });
  element.append(container);
  const canvas = element.ownerDocument.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "canvas",
  ) as HTMLCanvasElement;
  canvas.width = canvas.height = 1;
  let context: CanvasRenderingContext2D | null = null;
  let previous: ReadonlyArray<readonly [string, string]> = [];
  let colors: ChromeColors | undefined;
  return {
    read: (): ChromeColors | undefined => {
      const resolved = samples.map(
        ([name, sample]) =>
          [name, sample.ownerDocument.defaultView!.getComputedStyle(sample).color] as const,
      );
      if (resolved.some(([, color]) => color === "")) return undefined;
      if (
        colors !== undefined &&
        resolved.every(([, color], index) => previous[index]?.[1] === color)
      )
        return colors;
      context ??= canvas.getContext("2d", { colorSpace: "srgb", willReadFrequently: true });
      if (context === null) throw new Error("Inkbook chrome requires a 2D color context.");
      colors = Object.fromEntries(
        resolved.map(([name, color]) => [name, resolveChromeColor(context!, color)]),
      ) as unknown as ChromeColors;
      previous = resolved;
      return colors;
    },
    dispose: () => {
      container.remove();
      canvas.width = canvas.height = 0;
      context = null;
      colors = undefined;
      previous = [];
    },
  };
}

/** Let the browser convert modern host colors; Motion receives only numeric RGBA. */
function resolveChromeColor(context: CanvasRenderingContext2D, color: string): string {
  context.clearRect(0, 0, 1, 1);
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue, alpha] = context.getImageData(0, 0, 1, 1).data;
  return `rgba(${String(red)}, ${String(green)}, ${String(blue)}, ${String(alpha! / 255)})`;
}
