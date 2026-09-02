import type { Queue } from "./queue";
import { retry } from "./retry";
import { Bus } from "./bus";

export class Registry {
  private queues = new Map<string, Queue>();
  private bus = new Bus();

  register(name: string, queue: Queue): void {
    this.queues.set(name, queue);
    this.bus.emit("registered", name);
  }

  async publishAll(msg: string): Promise<number> {
    let count = 0;
    for (const q of this.queues.values()) {
      await retry(() => q.publish(msg), { attempts: 2 });
      count += 1;
    }
    return count;
  }

  get(name: string): Queue | undefined {
    return this.queues.get(name);
  }
}

export function createRegistry(): Registry {
  return new Registry();
}
