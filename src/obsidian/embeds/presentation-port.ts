import type { InitialPresentationEntrance } from "./presentation-entrance";
import type { MotionPreference } from "../../rendering/motion/transitions";
import type { AttachmentIdentity } from "../../editor/session/session-state";
import type { ColorSchemeBroadcaster } from "../theme/color-scheme";
import type { InkbookDocumentRecognitionPort } from "./document-recognition";
import type { PresentationLifecycleRegistry } from "./presentation-lifecycle-registry";
import type { PreviewContentIdentity } from "./safe-preview-svg";
import type { PresentationScrollRangeReserve } from "./transition-scroll-stability";

export interface ResolvedInkbookDocument {
  readonly documentId: string;
  readonly resourceUrl: string;
}

export interface LivePreviewEmbedReference {
  readonly documentId: string;
  readonly from: number;
  readonly kind: "live-preview";
  readonly sourcePath: string;
  readonly to: number;
}

export interface ReadingViewEmbedReference {
  readonly documentId: string;
  readonly kind: "reading-view";
  readonly markdown: string;
  readonly section: {
    readonly lineEnd: number;
    readonly lineStart: number;
    readonly text: string;
  };
  readonly sectionFrom: number;
  readonly sectionTo: number;
  readonly sourcePath: string;
}

export type PresentationEmbedReference = LivePreviewEmbedReference | ReadingViewEmbedReference;

export interface PresentationRemovalSpacing {
  readonly before: number;
  readonly after: number;
}

export interface PresentationRemovalRange {
  readonly from: number;
  readonly to: number;
}

export interface PresentationRemoval {
  begin(range: PresentationRemovalRange): Promise<boolean>;
  reset(): void;
  removeMarkdown?(
    range: PresentationRemovalRange,
    expectedSource: string,
    mutate: () => void,
  ): boolean | undefined;
}

export interface PresentationAttachment {
  readonly initialEntrance?: InitialPresentationEntrance;
  readonly removal?: PresentationRemoval;
  readonly attachmentGeneration: number;
  readonly attachmentId: string;
  readonly documentId: string;
  readonly embedReference: PresentationEmbedReference;
  readonly previewContentIdentity?: PreviewContentIdentity;
  readonly root: HTMLElement;
  readonly loadingStartedAt?: number;
  readonly whenPresented?: Promise<boolean>;
  readonly scrollRangeReserve?: PresentationScrollRangeReserve;
  readonly preview?: HTMLElement;
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly refreshPreview?: () => void;
  readonly setPreviewSource?: (source: string) => Promise<void>;
  readonly scrollOwner: () => HTMLElement | null;
}

export function presentationAttachmentKey(attachment: AttachmentIdentity): string {
  return `${attachment.attachmentId}:${attachment.attachmentGeneration}`;
}

export type PresentationAttachmentInput = Omit<
  PresentationAttachment,
  | "initialEntrance"
  | "removal"
  | "whenPresented"
  | "preview"
  | "previewContentIdentity"
  | "scrollOwner"
  | "scrollRangeReserve"
  | "setPreviewAspectRatio"
  | "refreshPreview"
  | "setPreviewSource"
>;

export function presentationPreviewOptions(
  attachment: PresentationAttachment,
): Pick<
  PresentationAttachment,
  | "initialEntrance"
  | "preview"
  | "scrollRangeReserve"
  | "setPreviewAspectRatio"
  | "refreshPreview"
  | "setPreviewSource"
> {
  return {
    ...(attachment.initialEntrance === undefined
      ? {}
      : { initialEntrance: attachment.initialEntrance }),
    ...(attachment.preview === undefined ? {} : { preview: attachment.preview }),
    ...(attachment.setPreviewAspectRatio === undefined
      ? {}
      : { setPreviewAspectRatio: attachment.setPreviewAspectRatio }),
    ...(attachment.refreshPreview === undefined
      ? {}
      : { refreshPreview: attachment.refreshPreview }),
    ...(attachment.setPreviewSource === undefined
      ? {}
      : { setPreviewSource: attachment.setPreviewSource }),
    ...(attachment.scrollRangeReserve === undefined
      ? {}
      : { scrollRangeReserve: attachment.scrollRangeReserve }),
  };
}

export interface PresentationSessionPort {
  getMotionPreference?(): MotionPreference;
  activate(attachment: PresentationAttachment): void;
  detach(attachment: PresentationAttachment): void;
  mount(attachment: PresentationAttachment): void;
}

export interface EmbedIntegrationPorts {
  readonly documents: InkbookDocumentRecognitionPort;
  readonly lifecycle: PresentationLifecycleRegistry;
  readonly resolveDocument: (
    linkpath: string,
    sourcePath: string,
  ) => ResolvedInkbookDocument | undefined;
  readonly scheme: ColorSchemeBroadcaster;
  readonly sessions: PresentationSessionPort;
}
