export interface ChunkedJsonLimits {
  /** Maximum number of simultaneously open object and array containers. */
  readonly maximumDepth: number;
  /** Maximum number of JSON values, including containers and scalar values. */
  readonly maximumNodes: number;
  /** Maximum number of direct entries in any object or array. */
  readonly maximumContainerEntries: number;
  /** Maximum decoded string/key code units plus number and literal token characters. */
  readonly maximumOutputCharacters: number;
  /** Fixed UTF-16 scratch capacity used while decoding one string. */
  readonly maximumStringScratchCharacters: number;
}
