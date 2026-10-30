import { GetQueueUrlCommand, SQSClient } from "@aws-sdk/client-sqs";
import type { AppConfig } from "../../config";

export function createSqsClient(config: AppConfig["sqs"]): SQSClient {
  return new SQSClient({
    region: config.region,
    ...(config.endpoint ? { endpoint: config.endpoint } : {}),
    // LocalStack accepts any credentials; real AWS uses the default provider chain.
    ...(config.endpoint
      ? {
          credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
          },
        }
      : {}),
    maxAttempts: 3,
  });
}

/** Resolves and caches queue URLs by name. */
export class QueueUrls {
  private readonly cache = new Map<string, string>();

  constructor(private readonly client: SQSClient) {}

  async get(queueName: string): Promise<string> {
    const cached = this.cache.get(queueName);
    if (cached) return cached;
    const { QueueUrl } = await this.client.send(new GetQueueUrlCommand({ QueueName: queueName }));
    if (!QueueUrl) throw new Error(`queue ${queueName} not found`);
    this.cache.set(queueName, QueueUrl);
    return QueueUrl;
  }
}
