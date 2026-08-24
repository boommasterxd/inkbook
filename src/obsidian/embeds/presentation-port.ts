import type { AttachmentIdentity } from "../../editor/session/session-state";
import type { ColorSchemeBroadcaster } from "../theme/color-scheme";
import type { InkbookDocumentRecognitionPort } from "./document-recognition";
import type { PresentationLifecycleRegistry } from "./presentation-lifecycle-registry";

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

export interface PresentationAttachment {
  readonly attachmentGeneration: number;
  readonly attachmentId: string;
  readonly documentId: string;
  readonly embedReference: PresentationEmbedReference;
  readonly root: HTMLElement;
  readonly preview?: HTMLElement;
  readonly setPreviewAspectRatio?: (aspectRatio: number) => void;
  readonly setPreviewSource?: (source: string) => Promise<void>;
  readonly scrollOwner: () => HTMLElement | null;
}

export function presentationAttachmentKey(attachment: AttachmentIdentity): string {
  return `${attachment.attachmentId}:${attachment.attachmentGeneration}`;
}

export type PresentationAttachmentInput = Omit<
  PresentationAttachment,
  "preview" | "scrollOwner" | "setPreviewAspectRatio" | "setPreviewSource"
>;

export function presentationPreviewOptions(
  attachment: PresentationAttachment,
): Pick<PresentationAttachment, "preview" | "setPreviewAspectRatio" | "setPreviewSource"> {
  return {
    ...(attachment.preview === undefined ? {} : { preview: attachment.preview }),
    ...(attachment.setPreviewAspectRatio === undefined
      ? {}
      : { setPreviewAspectRatio: attachment.setPreviewAspectRatio }),
    ...(attachment.setPreviewSource === undefined
      ? {}
      : { setPreviewSource: attachment.setPreviewSource }),
  };
}

export interface PresentationSessionPort {
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
