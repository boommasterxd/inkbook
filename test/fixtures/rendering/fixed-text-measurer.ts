import type { MeasuredText, TextMeasurer } from "../../../src/rendering/text/text-layout-types";

/** Deterministic browser measurement boundary for preparation and session integration. */
export class FixedTextMeasurer implements TextMeasurer {
  public prepareLineMetrics(): Promise<void> {
    return Promise.resolve();
  }

  public measure(text: string): MeasuredText {
    return { width: text.length * 8, ascent: 12, descent: 4 };
  }

  public dispose(): void {
    /* This adapter owns no native measurement resources. */
  }
}
