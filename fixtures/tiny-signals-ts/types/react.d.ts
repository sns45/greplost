/// <reference path="./jsx.d.ts" />

export type ReactNode = JSX.Element | string | number | null | undefined;

export declare function memo<P>(component: (props: P) => JSX.Element): (props: P) => JSX.Element;
export declare function forwardRef<P, R>(render: (props: P, ref: R) => JSX.Element): (props: P) => JSX.Element;
export declare function useState<S>(initial: S): [S, (next: S) => void];
export declare function useMemo<T>(factory: () => T, deps: unknown[]): T;

declare const React: {
  memo: typeof memo;
  forwardRef: typeof forwardRef;
  useState: typeof useState;
  useMemo: typeof useMemo;
};

export default React;
