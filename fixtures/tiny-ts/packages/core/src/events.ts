import { Bus } from "./bus";

export function formatEvent(event: string, name: string): string {
  return `${event}:${name}`;
}

export function createBus(): Bus {
  return new Bus();
}
