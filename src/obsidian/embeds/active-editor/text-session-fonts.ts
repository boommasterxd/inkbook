import type { FontResourceV2, TextStyleV2 } from "../../../domain/schema/public";
import type { WorkScheduler } from "../../../domain/scheduling/work-scheduler";
import { fontResourceCssFamily } from "../../../domain/text/font-family";
import {
  matchFontFace,
  textFontFaceRequest as textFontRequest,
  type FontFaceDescriptor,
} from "../../../domain/text/font-face-matching";
import { BUILTIN_FONT_FAMILIES, loadBuiltinFont } from "../../../persistence/fonts/builtin-fonts";
import type { FontFaceRequest } from "../../../persistence/fonts/font-resources";
import { serializeFontStylesheet } from "../../../persistence/serialization/output/text-fonts";
import type { SvgSceneRenderer } from "../../../rendering/scene/index";
import type { EditableDocumentModel } from "../document-session/document-model-port";
import type { TextFontBinding } from "./text-session-font-bindings";

export interface TextFontLibraryPort {
  match?(request: FontFaceRequest): (FontFaceDescriptor & { readonly id: string }) | undefined;
  resolve(request: FontFaceRequest, signal?: AbortSignal): Promise<FontResourceV2 | undefined>;
  choices(): readonly { readonly label: string; readonly value: string }[];
}

export { textFontFaceRequest as textFontRequest } from "../../../domain/text/font-face-matching";

export function textFontRequestKey(request: FontFaceRequest): string {
  return `${request.family}:${request.weight}:${request.style}`;
}

/** Native face loads and embedded payloads remain document-owned and content-addressed. */
export class TextSessionFonts {
  readonly #loaded = new Map<string, Promise<void>>();
  readonly #builtin = new Map<string, Promise<FontResourceV2>>();
  #registry: readonly FontResourceV2[] | undefined;
  #selected: ReadonlyMap<string, FontResourceV2> = new Map();

  public constructor(
    private readonly options: {
      readonly model: EditableDocumentModel;
      readonly renderer: SvgSceneRenderer;
      readonly scheduler: WorkScheduler;
      readonly library?: TextFontLibraryPort;
    },
  ) {}

  public resource(style: TextStyleV2): FontResourceV2 | undefined {
    const request = textFontRequest(style);
    return (
      this.#selected.get(textFontRequestKey(request)) ??
      matchFontFace(this.options.model.fontResources ?? [], request)
    );
  }

  public async load(
    requests: readonly FontFaceRequest[],
    signal: AbortSignal,
    options: {
      readonly retained?: readonly TextFontBinding[];
      readonly preserveEmbedded?: boolean;
      readonly base?: TextFontBinding;
    } = {},
  ): Promise<ReadonlyMap<string, FontResourceV2>> {
    const available = new Set((this.options.model.fontResources ?? []).map((font) => font.id));
    const selected = new Map<string, FontResourceV2>();
    const missing = new Map<string, FontResourceV2>();
    const { retainedFaces, aliases } = await collectFontBindings(
      options.retained,
      options.base,
      this.options.scheduler,
      signal,
    );
    for (const request of requests) {
      const face = await this.#resolve(
        request,
        signal,
        options.preserveEmbedded === true,
        aliases.get(request.family),
      );
      signal.throwIfAborted();
      selected.set(textFontRequestKey(request), face);
      if (!available.has(face.id)) missing.set(face.id, face);
    }
    if (missing.size) await this.options.model.ensureFontResources?.([...missing.values()]);
    signal.throwIfAborted();
    const registry = this.options.model.fontResources ?? [...selected.values()];
    if (registry !== this.#registry) {
      this.options.renderer.setTextFonts(serializeFontStylesheet(registry));
      this.#registry = registry;
    }
    for (const request of requests)
      await this.#loadNative(request, selected.get(textFontRequestKey(request))!, signal);
    const resources = new Map(registry.map((resource) => [resource.id, resource]));
    for (const binding of retainedFaces.values()) {
      const face = resources.get(binding.id);
      if (!face) throw new Error("A bound text font resource is unavailable.");
      await this.#loadNative(
        {
          family: binding.family,
          weight: binding.bold ? 700 : 400,
          style: binding.italic ? "italic" : "normal",
        },
        face,
        signal,
      );
    }
    this.#selected = selected;
    return selected;
  }

  async #resolve(
    request: FontFaceRequest,
    signal: AbortSignal,
    preserveEmbedded: boolean,
    aliases?: ReadonlySet<string>,
  ): Promise<FontResourceV2> {
    const available = this.options.model.fontResources ?? [];
    const candidates = available.map((resource) =>
      aliases?.has(resource.id) ? { ...resource, family: request.family } : resource,
    );
    const byId = new Map(available.map((resource) => [resource.id, resource]));
    const exact = matchFontFace(candidates, request, false);
    if (exact) return byId.get(exact.id)!;
    if (preserveEmbedded) {
      const retained = matchFontFace(candidates, request);
      if (retained) return byId.get(retained.id)!;
    }
    if (BUILTIN_FONT_FAMILIES.some((family) => family === request.family))
      return this.#builtinFace(request);
    const matched = this.options.library?.match?.(request);
    if (matched !== undefined) {
      const best = matchFontFace([...candidates, matched], request);
      const embedded = available.find((resource) => resource.id === best?.id);
      if (embedded) return embedded;
    }
    const resolved = await this.options.library?.resolve(request, signal);
    signal.throwIfAborted();
    if (resolved) return available.find((resource) => resource.id === resolved.id) ?? resolved;
    const fallback = matchFontFace(candidates, request);
    if (fallback) return byId.get(fallback.id)!;
    throw new Error("The requested font is unavailable.");
  }

  #builtinFace(request: FontFaceRequest): Promise<FontResourceV2> {
    const key = textFontRequestKey(request);
    let pending = this.#builtin.get(key);
    if (!pending) {
      pending = loadBuiltinFont(
        request.family,
        request.weight,
        request.style,
        this.options.scheduler,
      ).catch((error: unknown) => {
        this.#builtin.delete(key);
        throw error;
      });
      this.#builtin.set(key, pending);
    }
    return pending;
  }

  async #loadNative(
    request: FontFaceRequest,
    face: FontResourceV2,
    signal: AbortSignal,
  ): Promise<void> {
    signal.throwIfAborted();
    const key = `${face.id}:${request.weight}:${request.style}`;
    let loaded = this.#loaded.get(key);
    if (!loaded) {
      loaded = this.options.renderer.textDocument.fonts
        .load(`${request.style} ${request.weight} 24px "${fontResourceCssFamily(face.id)}"`)
        .then(() => undefined)
        .catch((error: unknown) => {
          this.#loaded.delete(key);
          throw error;
        });
      this.#loaded.set(key, loaded);
    }
    let abort = () => undefined as void;
    const cancelled = new Promise<never>((_resolve, reject) => {
      abort = () =>
        reject(
          signal.reason instanceof Error
            ? signal.reason
            : new Error("Text font loading was cancelled."),
        );
      signal.addEventListener("abort", abort, { once: true });
    });
    try {
      await Promise.race([loaded, cancelled]);
    } finally {
      signal.removeEventListener("abort", abort);
    }
  }

  public dispose(): void {
    this.#loaded.clear();
    this.#builtin.clear();
    this.#selected = new Map();
    this.#registry = undefined;
  }
}

async function collectFontBindings(
  bindings: readonly TextFontBinding[] | undefined,
  base: TextFontBinding | undefined,
  scheduler: WorkScheduler,
  signal: AbortSignal,
) {
  const retainedFaces = new Map<string, TextFontBinding>();
  const aliases = new Map<string, Set<string>>();
  const addAlias = (binding: TextFontBinding) => {
    const ids = aliases.get(binding.family) ?? new Set<string>();
    ids.add(binding.id);
    aliases.set(binding.family, ids);
  };
  for (const binding of bindings ?? []) {
    retainedFaces.set(`${binding.id}:${binding.bold}:${binding.italic}`, binding);
    addAlias(binding);
    const pending = scheduler.checkpoint(signal, "frame");
    if (pending !== undefined) await pending;
    signal.throwIfAborted();
  }
  if (base) {
    retainedFaces.set(`${base.id}:${base.bold}:${base.italic}`, base);
    if (!bindings?.length) addAlias(base);
  }
  return { retainedFaces, aliases };
}
