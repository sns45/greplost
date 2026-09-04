// Global JSX namespace, so the compiler-backed oracle can type a JSX return in this fixture
// the way it would in a repo with react installed. A corpus clone has no node_modules; this
// fixture stands in for the installed state (bench truth ruling 10.3).
declare namespace JSX {
  interface Element {
    readonly __jsx: unique symbol;
  }
  interface ElementChildrenAttribute {
    children: unknown;
  }
  interface IntrinsicElements {
    [name: string]: Record<string, unknown>;
  }
}
