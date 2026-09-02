import type { Priority } from "./types";

export interface Msg {
  id: string;
  body: string;
  priority: Priority;
}

export type Ack = { ok: true; id: string } | { ok: false; reason: string };

export interface Queue {
  publish(body: string): Promise<Ack>;
  poll(max: number): AsyncIterable<Msg>;
}
