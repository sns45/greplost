import { formatEvent } from "./events";
import type { Handler } from "./types";

export class Bus {
  private handlers: Handler[] = [];

  on(handler: Handler): void {
    this.handlers.push(handler);
  }

  emit(event: string, name: string): void {
    const label = formatEvent(event, name);
    for (const h of this.handlers) h(label);
  }
}
