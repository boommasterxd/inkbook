declare module "*.woff2?inline" {
  const DATA: string;
  export default DATA;
}

declare module "*.ttf?inline" {
  const DATA: string;
  export default DATA;
}

declare module "*-OFL.txt?raw" {
  const LICENSE: string;
  export default LICENSE;
}

declare module "*.wasm?url&inline" {
  const DATA: string;
  export default DATA;
}
