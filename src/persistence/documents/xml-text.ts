const XML_TEXT_ESCAPES: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
};

export function escapeXmlText(value: string): string {
  return value.replaceAll(/[&<>]/gu, (character) => XML_TEXT_ESCAPES[character]!);
}
