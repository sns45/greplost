export interface WorkerConfig {
  queueUrl: string;
  region: string;
}

export function loadConfig(): WorkerConfig {
  return {
    queueUrl: process.env.QUEUE_URL ?? "http://localhost:9324/queue/default",
    region: process.env.AWS_REGION ?? "us-east-1",
  };
}
