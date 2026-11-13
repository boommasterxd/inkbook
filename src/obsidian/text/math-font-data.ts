/** Statically included glyph ranges keep math conversion offline on desktop and mobile. */
import { MathJaxNewcmFont } from "@mathjax/mathjax-newcm-font/js/svg.js";
import type { DynamicFile } from "@mathjax/src/js/output/common/FontData.js";
import type { FrameCancellation, WorkScheduler } from "../../domain/scheduling/work-scheduler";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js";
import "@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js";

/** Dynamic ranges are already bundled; MathJax's normal setup needs no loader or global mutation. */
export class OfflineMathFont extends MathJaxNewcmFont {
  readonly #scheduler: WorkScheduler;
  readonly #signal: FrameCancellation;

  public constructor(scheduler: WorkScheduler, signal: FrameCancellation) {
    super();
    this.#scheduler = scheduler;
    this.#signal = signal;
  }

  public override async loadDynamicFile(dynamic: DynamicFile): Promise<void> {
    const handoff = this.#scheduler.checkpoint(this.#signal, "frame");
    if (handoff) await handoff;
    dynamic.setup(this);
  }
}
