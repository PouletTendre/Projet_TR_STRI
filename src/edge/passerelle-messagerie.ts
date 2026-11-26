import { randomUUID } from 'node:crypto';
import { AMQP_EXCHANGES, InMemoryAmqpBroker } from '../amqp/index.js';
import { chatInboxQueue, chatRoutingKey } from '../chat/transport.js';
import type {
  ChatAmqpTransport,
  ChatMessageHandler,
  EnveloppeChatAmqp,
  MessageChatPayload,
  ProprietesMessageChatAmqp,
  ProprietesPublicationChatAmqp,
  TypeMessageChat
} from '../chat/types.js';
import type {
  AmqpConsumerHandler,
  AmqpMessage,
  AmqpPublishProperties,
  NiveauSecurite
} from '../types/index.js';

const TYPES_MESSAGE_CHAT_AUTORISES = new Set<TypeMessageChat>([
  'INIT_ECHANGE',
  'MSG_TEXTE',
  'FIN_MSG'
]);

const NIVEAUX_SECURITE_AUTORISES = new Set<NiveauSecurite>([
  'NON_SECURISE',
  'SIGNE',
  'CHIFFRE',
  'SIGNE_ET_CHIFFRE'
]);

export type CodeErreurAclEdge =
  | 'ACL_CORRESPONDANT_INVALIDE'
  | 'ACL_ECHANGEUR_INTERDIT'
  | 'ACL_CLE_ROUTAGE_INTERDITE'
  | 'ACL_FILE_INTERDITE'
  | 'ACL_ENTETES_MANQUANTS'
  | 'ACL_USURPATION_EMETTEUR';

export class ErreurAclEdge extends Error {
  readonly code: CodeErreurAclEdge;
  readonly correspondantId?: string;
  readonly cible?: string;

  constructor(
    code: CodeErreurAclEdge,
    message: string,
    details: { correspondantId?: string; cible?: string } = {}
  ) {
    super(message);
    this.name = 'ErreurAclEdge';
    this.code = code;
    this.correspondantId = details.correspondantId;
    this.cible = details.cible;
  }
}

export interface PasserelleEdgeMessagerieConfig {
  broker: InMemoryAmqpBroker;
}

function verifierCorrespondantId(correspondantId: string): string {
  if (typeof correspondantId !== 'string' || correspondantId.trim() === '') {
    throw new ErreurAclEdge(
      'ACL_CORRESPONDANT_INVALIDE',
      'Identifiant de Correspondant obligatoire pour accéder à la Passerelle Edge Messagerie.'
    );
  }
  return correspondantId.trim();
}

function verifierRoutingKeyInbox(correspondantId: string, routingKey: string): void {
  if (
    typeof routingKey !== 'string' ||
    !routingKey.startsWith('inbox.') ||
    routingKey.length <= 'inbox.'.length ||
    /[*#\s]/.test(routingKey)
  ) {
    throw new ErreurAclEdge(
      'ACL_CLE_ROUTAGE_INTERDITE',
      `Clé de routage "${routingKey}" refusée par l'ACL Edge : seule la forme "inbox.<id_correspondant>" est autorisée.`,
      { correspondantId, cible: routingKey }
    );
  }
}

function verifierEntetesChat(
  correspondantId: string,
  payload: unknown,
  proprietes?: AmqpPublishProperties
): void {
  const headers = proprietes?.headers;
  if (!headers || typeof headers !== 'object') {
    throw new ErreurAclEdge(
      'ACL_ENTETES_MANQUANTS',
      'En-têtes AMQP obligatoires manquants (echange_id, type_message, niveau_securite).',
      { correspondantId }
    );
  }

  const echangeId = headers.echange_id;
  const typeMessage = headers.type_message;
  const niveauSecurite = headers.niveau_securite;

  if (typeof echangeId !== 'string' || echangeId.trim() === '') {
    throw new ErreurAclEdge(
      'ACL_ENTETES_MANQUANTS',
      'En-tête protocolaire obligatoire "echange_id" manquant ou vide.',
      { correspondantId }
    );
  }

  if (
    typeof typeMessage !== 'string' ||
    !TYPES_MESSAGE_CHAT_AUTORISES.has(typeMessage as TypeMessageChat)
  ) {
    throw new ErreurAclEdge(
      'ACL_ENTETES_MANQUANTS',
      'En-tête protocolaire obligatoire "type_message" manquant ou invalide.',
      { correspondantId }
    );
  }

  if (
    typeof niveauSecurite !== 'string' ||
    !NIVEAUX_SECURITE_AUTORISES.has(niveauSecurite as NiveauSecurite)
  ) {
    throw new ErreurAclEdge(
      'ACL_ENTETES_MANQUANTS',
      'En-tête protocolaire obligatoire "niveau_securite" manquant ou invalide.',
      { correspondantId }
    );
  }

  if (
    typeof headers.emetteur_id === 'string' &&
    headers.emetteur_id !== correspondantId
  ) {
    throw new ErreurAclEdge(
      'ACL_USURPATION_EMETTEUR',
      `Usurpation d'identité détectée dans l'en-tête "emetteur_id" ("${headers.emetteur_id}" vs "${correspondantId}").`,
      { correspondantId, cible: headers.emetteur_id }
    );
  }

  if (payload && typeof payload === 'object' && 'emetteurId' in payload) {
    const emetteurPayload = (payload as { emetteurId?: unknown }).emetteurId;
    if (typeof emetteurPayload === 'string' && emetteurPayload !== correspondantId) {
      throw new ErreurAclEdge(
        'ACL_USURPATION_EMETTEUR',
        `Usurpation d'identité détectée dans "payload.emetteurId" ("${emetteurPayload}" vs "${correspondantId}").`,
        { correspondantId, cible: emetteurPayload }
      );
    }
  }
}

/**
 * Passerelle Edge Messagerie appliquant un cloisonnement ACL/vhost AMQP strict
 * pour les clients externes (`CorrespondantClient`) :
 * - publication autorisée uniquement vers `ex.chat.messages` (`inbox.<id>`) avec en-têtes chat requis ;
 * - consommation autorisée uniquement sur sa propre file `q.chat.inbox.<correspondantId>` ;
 * - blocage systématique de `ex.pki.*`, `q.pki.*` et des boîtes de réception d'un tiers.
 */
export class PasserelleEdgeMessagerie {
  private readonly broker: InMemoryAmqpBroker;

  constructor(brokerOrConfig: InMemoryAmqpBroker | PasserelleEdgeMessagerieConfig) {
    this.broker =
      brokerOrConfig instanceof InMemoryAmqpBroker
        ? brokerOrConfig
        : brokerOrConfig.broker;
    this.broker.declareExchange(AMQP_EXCHANGES.CHAT_MESSAGES, 'direct', { durable: true });
  }

  async publier(
    correspondantId: string,
    exchange: string,
    routingKey: string,
    payload: unknown,
    proprietes: AmqpPublishProperties = {}
  ): Promise<void> {
    const id = verifierCorrespondantId(correspondantId);

    if (exchange !== AMQP_EXCHANGES.CHAT_MESSAGES) {
      throw new ErreurAclEdge(
        'ACL_ECHANGEUR_INTERDIT',
        `Accès refusé par l'ACL Edge : publication interdite vers l'échangeur "${exchange}" (seul "${AMQP_EXCHANGES.CHAT_MESSAGES}" est autorisé).`,
        { correspondantId: id, cible: exchange }
      );
    }

    verifierRoutingKeyInbox(id, routingKey);
    verifierEntetesChat(id, payload, proprietes);

    await this.broker.publish(exchange, routingKey, payload, {
      content_type: 'application/json',
      delivery_mode: 2,
      message_id: proprietes.message_id ?? randomUUID(),
      timestamp: proprietes.timestamp ?? new Date().toISOString(),
      ...proprietes
    });
  }

  async consommer<TPayload = unknown>(
    correspondantId: string,
    nomFile: string,
    handler: AmqpConsumerHandler<TPayload>
  ): Promise<string> {
    const id = verifierCorrespondantId(correspondantId);
    const fileAutorisee = chatInboxQueue(id);

    if (nomFile !== fileAutorisee) {
      throw new ErreurAclEdge(
        'ACL_FILE_INTERDITE',
        `Accès refusé par l'ACL Edge : consommation interdite de la file "${nomFile}" (seule "${fileAutorisee}" est autorisée pour "${id}").`,
        { correspondantId: id, cible: nomFile }
      );
    }

    this.broker.declareQueue(fileAutorisee, { durable: true });
    this.broker.bindQueue(fileAutorisee, AMQP_EXCHANGES.CHAT_MESSAGES, chatRoutingKey(id));

    return this.broker.consume<TPayload>(fileAutorisee, handler);
  }

  async abonner<TPayload = unknown>(
    correspondantId: string,
    nomFile: string,
    handler: AmqpConsumerHandler<TPayload>
  ): Promise<string> {
    return this.consommer(correspondantId, nomFile, handler);
  }

  desabonner(correspondantId: string, nomFile: string, consumerTag: string): boolean {
    const id = verifierCorrespondantId(correspondantId);
    const fileAutorisee = chatInboxQueue(id);
    if (nomFile !== fileAutorisee) {
      throw new ErreurAclEdge(
        'ACL_FILE_INTERDITE',
        `Accès refusé par l'ACL Edge : désabonnement interdit sur la file "${nomFile}".`,
        { correspondantId: id, cible: nomFile }
      );
    }
    return this.broker.unsubscribe(fileAutorisee, consumerTag);
  }

  creerTransportPourCorrespondant(correspondantId: string): ChatAmqpTransport {
    const id = verifierCorrespondantId(correspondantId);

    return {
      publierMessageChat: async (
        destinataireId: string,
        payload: MessageChatPayload,
        proprietes: ProprietesPublicationChatAmqp
      ): Promise<void> => {
        const propsNormalisees: ProprietesMessageChatAmqp = {
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

        await this.publier(
          id,
          AMQP_EXCHANGES.CHAT_MESSAGES,
          chatRoutingKey(destinataireId),
          payload,
          propsNormalisees
        );
      },

      abonnerBoiteReception: async (
        cibleCorrespondantId: string,
        handler: ChatMessageHandler
      ): Promise<string> => {
        const queueCible = chatInboxQueue(cibleCorrespondantId);
        return this.consommer<MessageChatPayload>(
          id,
          queueCible,
          async (msg: AmqpMessage<MessageChatPayload>) => {
            const enveloppe: EnveloppeChatAmqp = {
              exchange: msg.exchange,
              routingKey: msg.routingKey,
              payload: msg.payload,
              rawBody: msg.rawBody,
              properties: {
                content_type: msg.properties.content_type as 'application/json',
                delivery_mode: msg.properties.delivery_mode as 2,
                correlation_id: msg.properties.correlation_id ?? '',
                type: (msg.properties.type ??
                  msg.payload?.typeMessage) as ProprietesMessageChatAmqp['type'],
                message_id: msg.properties.message_id,
                timestamp: msg.properties.timestamp,
                headers: (msg.properties.headers ??
                  {}) as ProprietesMessageChatAmqp['headers']
              }
            };
            await handler(enveloppe);
          }
        );
      },

      desabonnerBoiteReception: (
        cibleCorrespondantId: string,
        consumerTag: string
      ): boolean => {
        return this.desabonner(id, chatInboxQueue(cibleCorrespondantId), consumerTag);
      }
    };
  }
}
