import {
  InMemoryJmsBroker,
  type JmsMessageInput,
  type JmsMessageHandler,
  type JmsTextMessage,
} from '../broker/index.js';
import { AclForbiddenDestinationError } from './errors.js';
import type { ClientContext } from './types.js';

export interface MessagingEdgeGatewayOptions {
  broker: InMemoryJmsBroker;
  enforceInboxIsolation?: boolean;
  validateProtocolHeaders?: boolean;
}

export class MessagingEdgeGateway {
  public readonly broker: InMemoryJmsBroker;
  public readonly enforceInboxIsolation: boolean;
  public readonly validateProtocolHeaders: boolean;

  constructor(options: MessagingEdgeGatewayOptions | InMemoryJmsBroker) {
    if (options instanceof InMemoryJmsBroker) {
      this.broker = options;
      this.enforceInboxIsolation = true;
      this.validateProtocolHeaders = false;
    } else {
      this.broker = options.broker;
      this.enforceInboxIsolation = options.enforceInboxIsolation ?? true;
      this.validateProtocolHeaders = options.validateProtocolHeaders ?? false;
    }
  }

  public assertDestinationAllowed(destination: string, clientContext?: ClientContext): void {
    // 1. Strict check: all PKI internal destinations are strictly forbidden
    if (
      destination.startsWith('queue.pki.') ||
      destination.startsWith('topic.pki.') ||
      destination.includes('.pki.')
    ) {
      throw new AclForbiddenDestinationError(
        destination,
        clientContext?.clientId,
        `Accès interdit à la destination interne PKI '${destination}' (ACL firewall).`
      );
    }

    // 2. Strict check: external chat is strictly restricted to point-to-point inbox queues
    // Multi-party group chat rooms / chat topics are strictly out of scope per spec.
    const isChatInboxQueue = destination.startsWith('queue.chat.inbox.');
    if (!isChatInboxQueue) {
      throw new AclForbiddenDestinationError(
        destination,
        clientContext?.clientId,
        `Destination '${destination}' interdite. Seules les files de messagerie point-à-point ('queue.chat.inbox.<id_correspondant>') sont autorisées pour les participants externes (les salons de discussion / topics multi-parties sont hors périmètre).`
      );
    }

    // 3. Optional inbox isolation check for receiving
    if (
      this.enforceInboxIsolation &&
      clientContext?.clientId &&
      destination.startsWith('queue.chat.inbox.')
    ) {
      const allowedInbox = `queue.chat.inbox.${clientContext.clientId}`;
      // In sending, destination can be another user's inbox (e.g. queue.chat.inbox.bob).
      // Inbox isolation applies specifically when subscribing/listening to an inbox.
    }
  }

  public assertConsumerDestinationAllowed(
    destination: string,
    clientContext?: ClientContext
  ): void {
    this.assertDestinationAllowed(destination, clientContext);

    if (
      this.enforceInboxIsolation &&
      clientContext?.clientId &&
      destination.startsWith('queue.chat.inbox.')
    ) {
      const expectedInbox = `queue.chat.inbox.${clientContext.clientId}`;
      if (destination !== expectedInbox) {
        throw new AclForbiddenDestinationError(
          destination,
          clientContext.clientId,
          `Violation ACL : le client '${clientContext.clientId}' ne peut pas s'abonner à l'inbox d'un tiers ('${destination}').`
        );
      }
    }
  }

  public validateHeaders(headers?: Record<string, any>): void {
    if (!this.validateProtocolHeaders) return;
    if (!headers) {
      throw new Error("En-têtes de protocole chat requis ('echange_id', 'type_message', 'niveau_securite').");
    }
    const required = ['echange_id', 'type_message', 'niveau_securite'];
    for (const reqHeader of required) {
      if (!headers[reqHeader]) {
        throw new Error(`En-tête obligatoire manquant : '${reqHeader}'.`);
      }
    }
  }

  public send(
    destination: string,
    messageInput: JmsMessageInput<any>,
    clientContext?: ClientContext
  ): void {
    this.assertDestinationAllowed(destination, clientContext);
    this.validateHeaders(messageInput.headers);
    this.broker.sendToQueue(destination, messageInput);
  }

  public publish(
    destination: string,
    messageInput: JmsMessageInput<any>,
    clientContext?: ClientContext
  ): void {
    this.assertDestinationAllowed(destination, clientContext);
    this.validateHeaders(messageInput.headers);
    this.broker.publish(destination, messageInput);
  }

  public subscribe(
    destination: string,
    handler: JmsMessageHandler<any>,
    clientContext?: ClientContext
  ): () => void {
    this.assertConsumerDestinationAllowed(destination, clientContext);
    return this.broker.subscribe(destination, handler);
  }

  public registerConsumer(
    destination: string,
    consumer: JmsMessageHandler<any>,
    clientContext?: ClientContext
  ): void {
    this.assertConsumerDestinationAllowed(destination, clientContext);
    this.broker.registerQueueConsumer(destination, consumer);
  }

  /**
   * Creates an external client broker bridge that conforms to InMemoryJmsBroker interface
   * but enforces Edge ACL rules on all destination calls.
   */
  public createClientBridge(clientId: string): MessagingEdgeClientBridge {
    return new MessagingEdgeClientBridge(this, clientId);
  }
}

/**
 * Adapter extending InMemoryJmsBroker so it can be passed directly as the broker
 * to CorrespondantClient or any external client library.
 */
export class MessagingEdgeClientBridge extends InMemoryJmsBroker {
  constructor(
    private readonly gateway: MessagingEdgeGateway,
    public readonly clientId: string
  ) {
    super();
  }

  public override sendToQueue<T = unknown>(
    queueName: string,
    input: JmsMessageInput<T>
  ): void {
    this.gateway.send(queueName, input, { clientId: this.clientId });
  }

  public override publish<T = unknown>(
    topicName: string,
    input: JmsMessageInput<T>
  ): void {
    this.gateway.publish(topicName, input, { clientId: this.clientId });
  }

  public override subscribe<T = unknown>(
    topicName: string,
    handler: JmsMessageHandler<T>
  ): () => void {
    return this.gateway.subscribe(topicName, handler, { clientId: this.clientId });
  }

  public override registerQueueConsumer<T = unknown>(
    queueName: string,
    consumer: JmsMessageHandler<T>
  ): void {
    this.gateway.registerConsumer(queueName, consumer, { clientId: this.clientId });
  }
}
