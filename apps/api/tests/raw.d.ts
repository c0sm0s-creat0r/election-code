// Vite's `?raw` suffix inlines a file as a string at build time. Test fixtures
// use it because the workers runtime cannot read from the host filesystem.
declare module '*?raw' {
  const content: string
  export default content
}
