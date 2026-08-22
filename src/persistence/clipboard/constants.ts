const INKBOOK_CLIPBOARD_MIME = "application/x-inkbook-elements+json;version=1" as const;

export const INKBOOK_CLIPBOARD_WEB_MIME = `web ${INKBOOK_CLIPBOARD_MIME}` as const;
export const INKBOOK_CLIPBOARD_TEXT_PREFIX = "Inkbook elements v1:" as const;

export {
  CLIPBOARD_SCHEMA_LIMITS as CLIPBOARD_LIMITS,
  FILE_SCHEMA_LIMITS as DOCUMENT_LIMITS,
} from "../../domain/schema/public";

export const REPEATED_PASTE_OFFSET = 24;
