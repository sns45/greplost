import { retry, Priority } from "@tiny/core";
import type { Queue, Ack, Msg } from "@tiny/core";
import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";

export interface SqsConfig {
  queueUrl: string;
  region: string;
}

export class SqsAdapter implements Queue {
  private client: SQSClient;

  constructor(private cfg: SqsConfig) {
    this.client = new SQSClient({ region: cfg.region });
  }

  async publish(body: string): Promise<Ack> {
    const cmd = new SendMessageCommand({ QueueUrl: this.cfg.queueUrl, MessageBody: body });
    const res = await retry(() => this.client.send(cmd), { attempts: 3 });
    return res.MessageId ? { ok: true, id: res.MessageId } : { ok: false, reason: "no id" };
  }

  async *poll(max: number): AsyncIterable<Msg> {
    for (let i = 0; i < max; i++) {
      yield { id: String(i), body: "", priority: Priority.Normal };
    }
  }
}

export function createSqsAdapter(cfg: SqsConfig): SqsAdapter {
  return new SqsAdapter(cfg);
}
