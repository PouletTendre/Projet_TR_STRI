export type JmsHeaderValue = string | number | boolean | null | undefined;

export interface JmsTextMessage<T = unknown> {
  headers: Record<string, JmsHeaderValue>;
  body: string;
  payload: T;
}

export interface JmsMessageInput<T = unknown> {
  headers?: Record<string, JmsHeaderValue>;
  payload: T;
}

export type JmsMessageHandler<T = unknown> = (
  message: JmsTextMessage<T>
) => void | Promise<void>;

export class InMemoryJmsBroker {
  private topicSubscribers = new Map<string, Set<JmsMessageHandler<any>>>();
  private queueMessages = new Map<string, JmsTextMessage<any>[]>();
  private queueConsumers = new Map<string, JmsMessageHandler<any>>();

  public subscribe<T = unknown>(
    topicName: string,
    handler: JmsMessageHandler<T>
  ): () => void {
    if (!this.topicSubscribers.has(topicName)) {
      this.topicSubscribers.set(topicName, new Set());
    }
    const handlers = this.topicSubscribers.get(topicName)!;
    handlers.add(handler as JmsMessageHandler<any>);

    return () => {
      handlers.delete(handler as JmsMessageHandler<any>);
    };
  }

  public publish<T = unknown>(
    topicName: string,
    input: JmsMessageInput<T>
  ): void {
    const body = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
    const message: JmsTextMessage<T> = {
      headers: { ...input.headers },
      body,
      payload: input.payload,
    };

    const handlers = this.topicSubscribers.get(topicName);
    if (handlers) {
      for (const handler of Array.from(handlers)) {
        handler(message);
      }
    }
  }

  public sendToQueue<T = unknown>(
    queueName: string,
    input: JmsMessageInput<T>
  ): void {
    const body = typeof input.payload === 'string' ? input.payload : JSON.stringify(input.payload);
    const message: JmsTextMessage<T> = {
      headers: { ...input.headers },
      body,
      payload: input.payload,
    };

    const consumer = this.queueConsumers.get(queueName);
    if (consumer) {
      consumer(message);
    } else {
      if (!this.queueMessages.has(queueName)) {
        this.queueMessages.set(queueName, []);
      }
      this.queueMessages.get(queueName)!.push(message);
    }
  }

  public registerQueueConsumer<T = unknown>(
    queueName: string,
    consumer: JmsMessageHandler<T>
  ): void {
    this.queueConsumers.set(queueName, consumer as JmsMessageHandler<any>);

    const pending = this.queueMessages.get(queueName);
    if (pending && pending.length > 0) {
      const messagesToDeliver = [...pending];
      this.queueMessages.set(queueName, []);
      for (const msg of messagesToDeliver) {
        consumer(msg);
      }
    }
  }
}
