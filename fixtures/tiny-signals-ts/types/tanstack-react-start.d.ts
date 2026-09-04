/// <reference path="./jsx.d.ts" />

export interface RouteOptions {
  component?: () => JSX.Element;
  loader?: (...args: never[]) => unknown;
  beforeLoad?: (...args: never[]) => unknown;
}

export interface FileRoute {
  useLoaderData(): unknown;
}

export declare function createFileRoute(path: string): (options: RouteOptions) => FileRoute;
export declare function createRootRoute(options: RouteOptions): FileRoute;
export declare function createRootRouteWithContext<C>(): (options: RouteOptions) => FileRoute;
