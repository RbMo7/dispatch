declare module 'virtual:docs' {
  const manifest: import('./manifest').DocsManifest;
  export default manifest;
}

declare module 'virtual:docs-search' {
  const index: string;
  export default index;
}
