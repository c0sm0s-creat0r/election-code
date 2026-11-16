// Vite's `?raw` suffix inlines a file as a string. Fixtures use it because
// the workers runtime cannot read the host filesystem.
declare module '*?raw' {
  const content: string
  export default content
}
