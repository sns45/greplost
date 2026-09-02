import { createRegistry } from "@tiny/core";
import { createSqsAdapter, MemoryAdapter } from "@tiny/adapters";
import { loadConfig } from "./config";

export async function main(): Promise<void> {
  const config = loadConfig();
  const registry = createRegistry();
  registry.register("sqs", createSqsAdapter({ queueUrl: config.queueUrl, region: config.region }));
  registry.register("memory", new MemoryAdapter());
  const published = await registry.publishAll("hello");
  console.log(`published to ${published} queues`);
}

main();
