/** The one source file the image ships, so a `COPY` source has exactly one real target. */
export function serve(port: number): string {
  return `listening on ${port}`;
}
