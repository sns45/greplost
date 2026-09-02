import { greet } from "./greet";
import type { Greeting } from "./greet";

export type { Greeting };

export function hello(name: string): string {
  const greeting: Greeting = greet(name);
  return greeting.text;
}
