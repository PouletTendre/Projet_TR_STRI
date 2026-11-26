import { randomUUID } from 'node:crypto';
import type {
  AmqpConsumerHandler,
  AmqpExchangeType,
  AmqpMessage,
  AmqpProperties,
  AmqpPublishProperties
} from '../types/index.js';

export const AMQP_EXCHANGES = {
  COMMANDES: 'ex.pki.commandes',
  PUBLICATIONS: 'ex.pki.publications',
  CHAT_MESSAGES: 'ex.chat.messages'
} as const;

export interface ExchangeOptions {
  durable?: boolean;
}

export interface QueueOptions {
  durable?: boolean;
}

export interface ExchangeMetadata {
  name: string;
  type: AmqpExchangeType;
  durable: boolean;
}

export interface QueueMetadata {
  name: string;
  durable: boolean;
  bufferedCount: number;
  consumerCount: number;
}

export interface BindingMetadata {
  queue: string;
  exchange: string;
  routingKey: string;
}

interface StoredMessage {
  exchange: string;
  routingKey: string;
  rawBody: string;
  properties: AmqpProperties;
}

interface ConsumerEntry {
  consumerTag: string;
  handler: AmqpConsumerHandler<unknown>;
}

interface QueueState {
  name: string;
  durable: boolean;
  messages: StoredMessage[];
  consumers: ConsumerEntry[];
  nextConsumerIndex: number;
}

interface ExchangeState {
  name: string;
  type: AmqpExchangeType;
  durable: boolean;
}

function splitTopicWords(value: string): string[] {
  return value === '' ? [] : value.split('.');
}

/**
 * Évalue une clé de routage AMQP 0-9-1 sur un échangeur topic.
 * `*` correspond à exactement un mot, `#` correspond à zéro ou plusieurs mots.
 */
export function matchTopicRoutingKey(pattern: string, routingKey: string): boolean {
  const patternWords = splitTopicWords(pattern);
  const keyWords = splitTopicWords(routingKey);

  const memo = new Map<string, boolean>();

  const matchFrom = (pIdx: number, kIdx: number): boolean => {
    const memoKey = `${pIdx}:${kIdx}`;
    const cached = memo.get(memoKey);
    if (cached !== undefined) {
      return cached;
    }

    let result = false;

    if (pIdx === patternWords.length && kIdx === keyWords.length) {
      result = true;
    } else if (pIdx < patternWords.length) {
      const token = patternWords[pIdx];
      if (token === '#') {
        // '#' consomme 0 mot ou 1+ mots
        result =
          matchFrom(pIdx + 1, kIdx) ||
          (kIdx < keyWords.length && matchFrom(pIdx, kIdx + 1));
      } else if (kIdx < keyWords.length && (token === '*' || token === keyWords[kIdx])) {
        result = matchFrom(pIdx + 1, kIdx + 1);
      }
    }

    memo.set(memoKey, result);
    return result;
  };

  return matchFrom(0, 0);
}

function cloneProperties(props: AmqpProperties): AmqpProperties {
  return {
    ...props,
    headers: props.headers ? (JSON.parse(JSON.stringify(props.headers)) as Record<string, unknown>) : undefined
  };
}

function buildDeliveryMessage<TPayload>(stored: StoredMessage): AmqpMessage<TPayload> {
  return {
    exchange: stored.exchange,
    routingKey: stored.routingKey,
    rawBody: stored.rawBody,
    payload: JSON.parse(stored.rawBody) as TPayload,
    properties: cloneProperties(stored.properties)
  };
}

/**
 * Courtier AMQP 0-9-1 en mémoire supportant les échangeurs direct/topic,
 * les files durables, le routage sans doublon par file, la mise en file FIFO
 * et la remise ordonnée avec propriétés AMQP standard.
 */
export class InMemoryAmqpBroker {
  private readonly exchanges = new Map<string, ExchangeState>();
  private readonly queues = new Map<string, QueueState>();
  private readonly bindings: BindingMetadata[] = [];

  declareExchange(
    nom: string,
    type: AmqpExchangeType,
    options: ExchangeOptions = {}
  ): void {
    const existing = this.exchanges.get(nom);
    if (existing) {
      if (existing.type !== type) {
        throw new Error(
          `Conflit de déclaration d'échangeur "${nom}": type existant "${existing.type}", demandé "${type}".`
        );
      }
      return;
    }

    this.exchanges.set(nom, {
      name: nom,
      type,
      durable: options.durable ?? true
    });
  }

  declareQueue(nom: string, options: QueueOptions = {}): void {
    if (this.queues.has(nom)) {
      return;
    }

    this.queues.set(nom, {
      name: nom,
      durable: options.durable ?? true,
      messages: [],
      consumers: [],
      nextConsumerIndex: 0
    });
  }

  bindQueue(nomFile: string, nomEchangeur: string, cleBinding: string): void {
    if (!this.queues.has(nomFile)) {
      throw new Error(`File AMQP introuvable pour binding: "${nomFile}".`);
    }
    if (!this.exchanges.has(nomEchangeur)) {
      throw new Error(`Échangeur AMQP introuvable pour binding: "${nomEchangeur}".`);
    }

    const exists = this.bindings.some(
      (b) =>
        b.queue === nomFile &&
        b.exchange === nomEchangeur &&
        b.routingKey === cleBinding
    );
    if (!exists) {
      this.bindings.push({
        queue: nomFile,
        exchange: nomEchangeur,
        routingKey: cleBinding
      });
    }
  }

  async publish<TPayload = unknown>(
    nomEchangeur: string,
    cleRoutage: string,
    payload: TPayload,
    proprietes: AmqpPublishProperties = {}
  ): Promise<void> {
    const exchange = this.exchanges.get(nomEchangeur);
    if (!exchange) {
      throw new Error(`Échangeur AMQP introuvable lors de la publication: "${nomEchangeur}".`);
    }

    const rawBody = JSON.stringify(payload ?? null);
    const properties: AmqpProperties = {
      content_type: proprietes.content_type ?? 'application/json',
      delivery_mode: proprietes.delivery_mode ?? 2,
      message_id: proprietes.message_id ?? randomUUID(),
      timestamp: proprietes.timestamp ?? new Date().toISOString(),
      ...(proprietes.type !== undefined ? { type: proprietes.type } : {}),
      ...(proprietes.correlation_id !== undefined
        ? { correlation_id: proprietes.correlation_id }
        : {}),
      ...(proprietes.reply_to !== undefined ? { reply_to: proprietes.reply_to } : {}),
      ...(proprietes.headers !== undefined
        ? {
            headers: JSON.parse(JSON.stringify(proprietes.headers)) as Record<
              string,
              unknown
            >
          }
        : {})
    };

    const stored: StoredMessage = {
      exchange: nomEchangeur,
      routingKey: cleRoutage,
      rawBody,
      properties
    };

    const targetQueueNames = new Set<string>();
    for (const binding of this.bindings) {
      if (binding.exchange !== nomEchangeur) {
        continue;
      }
      const matched =
        exchange.type === 'direct'
          ? binding.routingKey === cleRoutage
          : matchTopicRoutingKey(binding.routingKey, cleRoutage);

      if (matched) {
        targetQueueNames.add(binding.queue);
      }
    }

    for (const queueName of targetQueueNames) {
      const queue = this.queues.get(queueName);
      if (!queue) {
        continue;
      }
      queue.messages.push(stored);
      await this.drainQueue(queue);
    }
  }

  async consume<TPayload = unknown>(
    nomFile: string,
    handler: AmqpConsumerHandler<TPayload>
  ): Promise<string> {
    const queue = this.queues.get(nomFile);
    if (!queue) {
      throw new Error(`File AMQP introuvable pour consommation: "${nomFile}".`);
    }

    const consumerTag = randomUUID();
    queue.consumers.push({
      consumerTag,
      handler: handler as AmqpConsumerHandler<unknown>
    });

    await this.drainQueue(queue);
    return consumerTag;
  }

  unsubscribe(nomFile: string, consumerTag: string): boolean {
    const queue = this.queues.get(nomFile);
    if (!queue) {
      return false;
    }

    const initialLength = queue.consumers.length;
    queue.consumers = queue.consumers.filter((c) => c.consumerTag !== consumerTag);
    if (queue.consumers.length > 0) {
      queue.nextConsumerIndex = queue.nextConsumerIndex % queue.consumers.length;
    } else {
      queue.nextConsumerIndex = 0;
    }
    return queue.consumers.length !== initialLength;
  }

  listExchanges(): ExchangeMetadata[] {
    return Array.from(this.exchanges.values()).map((e) => ({ ...e }));
  }

  listQueues(): QueueMetadata[] {
    return Array.from(this.queues.values()).map((q) => ({
      name: q.name,
      durable: q.durable,
      bufferedCount: q.messages.length,
      consumerCount: q.consumers.length
    }));
  }

  listBindings(): BindingMetadata[] {
    return this.bindings.map((b) => ({ ...b }));
  }

  private async drainQueue(queue: QueueState): Promise<void> {
    while (queue.messages.length > 0 && queue.consumers.length > 0) {
      const nextMessage = queue.messages.shift();
      if (!nextMessage) {
        break;
      }

      const consumer = queue.consumers[queue.nextConsumerIndex % queue.consumers.length];
      queue.nextConsumerIndex = (queue.nextConsumerIndex + 1) % queue.consumers.length;
      if (!consumer) {
        queue.messages.unshift(nextMessage);
        break;
      }

      await consumer.handler(buildDeliveryMessage(nextMessage));
    }
  }
}
