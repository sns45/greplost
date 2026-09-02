import type { Queue, Ack, Msg } from "@tiny/core";

export class MemoryAdapter implements Queue {
  private items: Msg[] = [];

  async publish(body: string): Promise<Ack> {
    const { Priority } = await import("@tiny/core");
    const id = String(this.items.length + 1);
    this.items.push({ id, body, priority: Priority.Low });
    return { ok: true, id };
  }

  async *poll(max: number): AsyncIterable<Msg> {
    yield* this.items.slice(0, max);
  }
}
