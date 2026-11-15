# Images and PDF Pages

## Import and Local Processing

An active drawing accepts PNG, JPEG and static WebP images and explicitly selected PDF pages. PDF pages become image elements, not editable vector shapes or text fields. Import uses Obsidian's public `loadPdfJs()` renderer without a separate PDF dependency or remote conversion service. Sources stay unchanged. PDF rendering cannot fetch remote font or CMap resources; unavailable local resources are not retrieved from the network. Host renderer limitations can affect PDF fidelity as described below.

Raster import normalizes orientation once, removes source metadata through local canvas encoding, and retains one immutable PNG, JPEG or WebP resource. A source within the separate source limits is decoded once, then reduced proportionally into one bounded output canvas when necessary. The resize uses the orientation-normalized dimensions and high-quality image smoothing, never enlarges a source, and retains transparency. The original file is not modified. PDF pages render sequentially and share the same output-sizing and encoding policy. Cancellation releases temporary bitmaps, canvases, PDF render tasks and the owned PDF loading task. Import rejects unsupported sources, detected decoding failures and exceeded admission limits before committing elements.

PDF selection uses one-based page numbers and ascending inclusive ranges, such as `1, 3-5`. Duplicate selections are removed and pages are processed in ascending document order. PDF pages retain their proportional writing-width placement and are placed vertically. Standalone raster images initially fit within 40 percent of the writing width in both width and height, without enlarging a smaller source. This initial element size does not reduce the stored pixels; subsequent selection resizing remains proportional and uses the same resource. Import-source classification is transient and does not extend the persisted schema. An import batch commits as one undo step.

The import dialog starts with one compact file picker. A selected source shows its filename, a replace action and a framed preview with pixel dimensions. During preparation, the same card instead centers a spinner above the preparation message; filenames and review content are hidden until preparation finishes. PDF batch preparation identifies the current page below the spinner. A single native animation runs only while preparation is active and the document is visible, stops immediately on completion or closure, and remains static for reduced motion. A separate polite status outside the busy body announces preparation without delaying Cancel. A yellow inline status identifies automatic raster reduction with both original and resulting dimensions; replacing the source clears it. This transient notice is not persisted with the resource. Page selection, preview-page navigation and resolution appear only for PDFs. Expected admission failures identify the relevant file-size, image-dimension, decoding, page-selection or batch-capacity problem without exposing native exception text. Errors reuse the standard inline validation style. Empty status and error regions reserve no visual space. The body owns scrolling while the Cancel/Insert actions remain visible, including in the phone sheet. Content changes reuse the shared dialog-height motion and reduced-motion policy without restarting the modal or decoding the source again.

## Element Geometry and Crop

An `ImageElementV3` has the common `id`, `createdAt`, clockwise `rotation` and page-space `pivot`, plus:

```ts
interface ImageGeometryV3 {
  kind: "image";
  x: number;
  y: number;
  width: number;
  height: number;
  assetId: string;
  crop: { x: number; y: number; width: number; height: number };
}
```

`x`, `y`, `width` and `height` describe the visible unrotated page-space box. `crop` describes its visible rectangle in orientation-normalized source pixels. Its origin is nonnegative, its dimensions are positive, and it remains inside the resource bounds. Geometry follows the common canonical rounding and numeric limits in [File Format and Geometry](file-format.md#shared-types).

Images occupy the bottom image band, below all highlighters and other annotations. Selection, move, resize, rotate, arrange, duplicate, clipboard and removal use the existing element command and history paths. Arrangement changes order only within the image band. Resizing an image or a group containing images preserves proportions and retains a minimum image extent of 0.001 page units. Images are rectangular selection geometry, not connector targets. The eraser skips images; use selection removal to delete them.

Crop is nondestructive. Applying a crop changes only the element crop and visible box; it neither replaces nor rerasterizes the resource. Retained pixels remain stationary, including for a rotated image. Restoring a larger crop reveals retained source pixels. Choosing Crop replaces the selection overlay directly on the canvas with eight freely draggable edge and corner grips. The frame and grips use the primary chrome accent; corners use L-shaped marks, edges use short bars, and the retained area has no selection tint. The full source remains visible with darkened excluded areas, below highlights and annotations. Dragging inside the crop moves its rectangle within the source. A small neutral pill toolbar above the image provides Cancel and Apply with normal text-colored icons. Its owned chrome layer can extend above the drawing surface while staying within the embed and visible viewport; its touch targets remain clear of the top grip.

Focused grips respond to arrow keys in one-source-pixel steps, or ten pixels while Shift is held. The crop area supports the same keyboard movement. Home restores the full source rectangle, Enter confirms, and Escape cancels. Tab cycles through the crop controls; accessible instructions describe these alternatives to dragging and the retained source data. Pointer cancellation or lost pointer capture restores only the crop captured at drag start. Cancel leaves the element unchanged; Apply commits a changed crop as one undo step; an unchanged crop creates no history entry. Normal canvas editing is temporarily disabled while crop controls remain interactive. A document change, owner cancellation or presentation disposal cancels the draft and releases its controls and shared image lease.

The source reveal shares the scene's existing image definition and decoder, including for transparent images. Crop feedback visits no other document elements and coalesces draft painting through the central scheduler. Camera changes reposition the controls; live drag and the exact confirmation/cancellation handoff remain immediate. Crop chrome uses the shared short opacity entrance and reduced-motion policy. The underlying scene retains its existing viewport culling.

## Resource Identity and Lifetime

A logical resource has exactly `id`, `mimeType`, `width`, `height` and `data`. `id` is the lowercase SHA-256 digest of the encoded bytes; `mimeType` is `image/png`, `image/jpeg` or `image/webp`; dimensions are positive integers; `data` is canonical Base64. Validation checks the encoded header, declared MIME and dimensions, digest, byte limits and every element binding. WebP validation admits static VP8, VP8L and VP8X containers with matching dimensions, bounded chunks and zero padding; animation flags and ANIM/ANMF chunks are rejected. The native decoder remains responsible for complete bitstream decoding. Conflicting definitions of one ID fail closed. Repeated elements share one resource.

The active session retains admitted immutable resources, including resources for deleted elements, until session disposal. This bounded first implementation deliberately avoids premature reclamation while Undo and Redo can restore an element. The same aggregate encoded-byte, pixel and resource-count limits include every retained Undo/Redo resource. Consequently, deleting an image does not immediately recover its session resource capacity. Schema validation rejects an over-limit resource set, and serialized session admission rejects an over-limit batch atomically without retaining a partial addition. Repeated references to one content-addressed resource consume the capacity only once; PDF batch preparation uses the same deduplication rule. Saved snapshots include only resources referenced by current elements; a fresh load omits unused resources. Geometry and camera changes reuse existing resources. Scene nodes remain imperative and spatially culled under [Rendering and Performance](rendering-and-performance.md).

## Capacity and Failure Behavior

The authoritative constants are `IMAGE_LIMITS` in `src/domain/images/image-limits.ts`.

| Capacity                                      |         Limit |
| --------------------------------------------- | ------------: |
| Source file bytes                             |        16 MiB |
| Pixels per raster source                      |    32,000,000 |
| Distinct resource pixels per document session |    32,000,000 |
| Pixels per resource                           |     4,000,000 |
| Width or height per resource                  | 16,384 pixels |
| Encoded bytes per resource                    |         8 MiB |
| Admitted resource bytes per document session  |        24 MiB |
| Resources per document session                |           128 |
| Selected PDF pages per batch                  |            20 |

Byte limits refer to decoded Base64 bytes, not Base64 characters. The complete SVG still obeys the 64 MiB document limit and clipboard payloads the 8 MiB limit in [File Format and Geometry](file-format.md#limits). Raster source headers must satisfy the source byte, pixel and common axis limits before native decoding. Decoded dimensions are checked again before allocating the output canvas. Persisted resources retain the stricter 4,000,000-pixel limit; the larger source allowance does not extend the version 3 resource format. PDF raster scale is bounded by the resource pixel and axis limits. Import preparation and resource admission remain cancellable and use the central scheduler where cooperative work is required. Browser decoding, canvas encoding and an individual host PDF render are native operations with separate cancellation boundaries. The 32,000,000-pixel admission limit corresponds to 128,000,000 bytes of RGBA pixels, approximately 122 MiB, for one uncompressed copy of all distinct admitted resources. A maximum-sized raster source and its 4,000,000-pixel output canvas account for approximately 137 MiB of pixel storage before encoding and other allocations. These arithmetic bounds are not total heap limits: browser and host PDF decoders can retain intermediate allocations, additional decoded copies and masks that these public APIs do not expose or bound in aggregate.

The output budget remains 4,000,000 pixels to bound individual visible resources. Raising it to 8,000,000 would double an individual RGBA copy from approximately 15 MiB to 31 MiB, while adding only about 41 percent linear resolution. Physical mobile-device evidence for that larger working set is not available. Smaller encoded files do not lower the decoded pixel count or establish faster rendering.

## Encoding and Reader Compatibility

Encoding requests native WebP at quality `1` and compares it with the previous format: PNG for PNG/WebP sources and PDF pages, JPEG at the existing `0.9` quality for JPEG sources. At most two encodes run serially, with the central scheduler's admission check between them. Raster import closes its source bitmap immediately after drawing into the bounded canvas, before either encoder runs. A WebP candidate is selected only when it is smaller, within the byte limit, and its validated container contains a lossless VP8L bitstream. The quality argument alone is not proof of lossless encoding. Only the chosen resource is hashed and converted to Base64. The transient header's lossless flag is not persisted.

Missing, failed, malformed or lossy WebP output uses the previous format. When an unsupported WebP request returns PNG for a PNG fallback, that same result is reused without another encode. The actual returned MIME and binary header must agree. The existing 16,384-pixel axis remains valid; a canvas above the native WebP encoder's 16,383-pixel axis skips the WebP attempt. Encoding does not add another lossy compression step. Native color-space and premultiplication conversions can round RGB values at translucent pixels; the lossless bitstream does not guarantee byte-identical RGBA output across different native encoders. Transparency and graphic content remain part of native SVG/PDF acceptance.

WebP is a deliberate MIME extension within snapshot version 3. Current readers retain PNG/JPEG support; older Inkbook builds that allow only PNG/JPEG reject WebP resources and need an update before editing these documents. Locked previews and native PDF export use the same validated self-contained SVG definitions. WebP decoding is required in the consuming SVG viewer; PNG/JPEG remain the baseline formats required by the SVG standard. Compatibility with every external SVG application is not guaranteed.

## Host PDF Renderer Limitations

Inkbook does not set PDF.js `maxImageSize`: the host renderer can silently omit an oversized source image and still resolve the page render successfully, producing a blank or incomplete page. `stopAtErrors: true` remains enabled, but host-suppressed decoder errors are not fully detectable through the public rendering API. A resolved render is therefore not proof that every PDF source component was reproduced. Check the page preview against the source PDF before insertion.

The 16 MiB source-file, 4,000,000-pixel output-resource and 32,000,000-distinct-pixel session admission limits remain enforced. Selected pages render sequentially, with cancellation and cleanup of owned temporary resources. These limits do not bound every native host decoder intermediate allocation or mask, and Inkbook cannot guarantee a hard aggregate decoder heap limit through the public host API.

## Persistence, Clipboard and Safe SVG

Writers use snapshot version 3 when image elements are present, version 2 for text without images, and version 1 otherwise. Readers retain version 1 and 2 support. Clipboard payloads containing images use version 3 and carry only the resources referenced by the selected elements. Paste remaps element IDs while retaining content-addressed resource identity and commits through the existing atomic paste path. Devices editing version 3 documents require a compatible Inkbook version.

A saved SVG embeds each used raster payload exactly once in `defs#inkbook-images`, as an `image` with ID `inkbook-image-<sha256>` and a PNG, JPEG or WebP Base64 data URL. Disk metadata stores matching descriptors without duplicate `data`; validated loading restores the logical resources. Each instance uses a rotation group containing a clipped nested SVG with the crop as its `viewBox` and one local `use` reference. The image group precedes highlights and content. Raster colors are preserved in both themes.

The safe-envelope parser accepts only this fixed image grammar, bounded resources and matching local leaf references. It rejects missing resources, invalid crops, duplicate IDs, external URLs, reference cycles and arbitrary image markup. Locked previews import only fully validated definitions and instances into their lifecycle-owned SVG. This extension does not allow general SVG references, external images or executable content. The remaining envelope rules and standalone fidelity contract are defined in [Standalone SVG Envelope](svg-envelope.md#image-extension).
