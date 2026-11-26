import { randomUUID } from 'node:crypto';
import { AMQP_EXCHANGES, InMemoryAmqpBroker } from '../amqp/index.js';
import type { AmqpMessage } from '../types/index.js';
import type {
  ChatAmqpTransport,
  ChatMessageHandler,
  EnveloppeChatAmqp,
  MessageChatPayload,
  ProprietesMessageChatAmqp,
  ProprietesPublicationChatAmqp
} from './types.js';

export const EXCHANGE_CHAT_MESSAGES = AMQP_EXCHANGES.CHAT_MESSAGES;

export function chatRoutingKey(correspondantId: string): string {
  return `inbox.${correspondantId}`;
}

export function chatInboxQueue(correspondantId: string): string {
  return `q.chat.inbox.${correspondantId}`;
}

/**
 * Normalise les propriétés AMQP 0-9-1 d'un message de messagerie sécurisée sortant.
 */
export function normaliserProprietesChat(
  proprietes: ProprietesPublicationChatAmqp
): ProprietesMessageChatAmqp {
  return {
    content_type: 'application/json',
    delivery_mode: 2,
    correlation_id: proprietes.correlation_id,
    type: proprietes.type,
    message_id: proprietes.message_id ?? randomUUID(),
    timestamp: proprietes.timestamp ?? new Date().toISOString(),
    headers: {
      ...proprietes.headers
    }
  };
}

/**
 * Convertit un message AMQP brut en enveloppe typée `EnveloppeChatAmqp`.
 */
export function convertirMessageAmqpEnEnveloppeChat(
  msg: AmqpMessage<MessageChatPayload>
): EnveloppeChatAmqp {
  return {
    exchange: msg.exchange,
    routingKey: msg.routingKey,
    payload: msg.payload,
    rawBody: msg.rawBody,
    properties: {
      content_type: msg.properties.content_type as 'application/json',
      delivery_mode: msg.properties.delivery_mode as 2,
      correlation_id: msg.properties.correlation_id ?? '',
      type: (msg.properties.type ?? msg.payload?.typeMessage) as ProprietesMessageChatAmqp['type'],
      message_id: msg.properties.message_id,
      timestamp: msg.properties.timestamp,
      headers: (msg.properties.headers ?? {}) as ProprietesMessageChatAmqp['headers']
    }
  };
}

/**
 * Implémentation AMQP 0-9-1 du transport de messagerie texte sur `ex.chat.messages` (`direct`, durable),
 * avec routage `inbox.<id_correspondant>` vers la file durable `q.chat.inbox.<id_correspondant>`.
 */
export class DirectAmqpChatTransport implements ChatAmqpTransport {
  private readonly broker: InMemoryAmqpBroker;

  constructor(broker: InMemoryAmqpBroker) {
    this.broker = broker;
    this.broker.declareExchange(EXCHANGE_CHAT_MESSAGES, 'direct', { durable: true });
  }

  async publierMessageChat(
    correspondantRecepteurId: string,
    payload: MessageChatPayload,
    proprietes: ProprietesPublicationChatAmqp
  ): Promise<void> {
    const routingKey = chatRoutingKey(correspondantRecepteurId);
    const propsNormalisees = normaliserProprietesChat(proprietes);

    await this.broker.publish(
      EXCHANGE_CHAT_MESSAGES,
      routingKey,
      payload,
      propsNormalisees
    );
  }

  async abonnerBoiteReception(
    correspondantId: string,
    handler: ChatMessageHandler
  ): Promise<string> {
    const queue = chatInboxQueue(correspondantId);
    const routingKey = chatRoutingKey(correspondantId);

    this.broker.declareQueue(queue, { durable: true });
    this.broker.bindQueue(queue, EXCHANGE_CHAT_MESSAGES, routingKey);

    return this.broker.consume<MessageChatPayload>(
      queue,
      async (msg: AmqpMessage<MessageChatPayload>) => {
        await handler(convertirMessageAmqpEnEnveloppeChat(msg));
      }
    );
  }

  desabonnerBoiteReception(correspondantId: string, consumerTag: string): boolean {
    return this.broker.unsubscribe(chatInboxQueue(correspondantId), consumerTag);
  }
}
