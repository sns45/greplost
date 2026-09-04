export declare class Output<T> {
  apply<U>(fn: (value: T) => U): Output<U>;
}

export declare class Resource {
  constructor(type: string, name: string, args?: unknown, opts?: unknown);
  readonly urn: Output<string>;
}

export declare class CustomResource extends Resource {
  readonly id: Output<string>;
}

export declare class ComponentResource extends Resource {}

export declare class ProviderResource extends CustomResource {}

export declare class Config {
  constructor(name?: string);
  get(key: string): string | undefined;
}

export declare function getStack(): string;
