import { randomUUID } from 'node:crypto';
import { InMemoryJmsBroker, JmsTextMessage } from '../broker/index.js';
import {
  NiveauSecurite,
  TypeMessageChat,
  MessageChat,
  EchangeSession,
  InitialiserEchangeOptions,
  EnvoyerMessageOptions,
  MessageChatListener,
} from './types.js';
import {
  ExchangeClosedError,
  ExchangeNotFoundError,
  SecurityLevelMismatchError,
  SequenceNumberError,
} from './errors.js';

export class CorrespondantClient {
  public readonly id: string;
  private broker: InMemoryJmsBroker;
  private echanges = new Map<string, EchangeSession>();
  private listeners = new Set<MessageChatListener>();
  public certificatNumeroSerie?: string;

  constructor(
    id: string,
    broker: InMemoryJmsBroker,
    certificatNumeroSerie?: string
  ) {
    this.id = id;
    this.broker = broker;
    this.certificatNumeroSerie = certificatNumeroSerie;

    this.broker.registerQueueConsumer(
      `queue.chat.inbox.${this.id}`,
      (msg) => {
        this.traiterMessageEntrant(msg);
      }
    );
  }

  public initialiserEchange(
    destinataireId: string,
    options?: InitialiserEchangeOptions
  ): EchangeSession {
    const echangeId = options?.echangeId ?? `ech-${randomUUID()}`;
    const niveauSecurite: NiveauSecurite =
      options?.niveauSecurite ?? 'NON_SECURISE';
    const premierMessage = options?.premierMessage ?? 'INIT_ECHANGE';
    const horodatage = new Date().toISOString();

    const isFin = premierMessage === 'FIN_MSG';
    const typeMessage: TypeMessageChat = isFin ? 'FIN_MSG' : 'INIT_ECHANGE';

    const session: EchangeSession = {
      echangeId,
      interlocuteurId: destinataireId,
      expediteurInitialId: this.id,
      niveauSecurite,
      etat: isFin ? 'TERMINE' : 'ACTIF',
      dernierNumeroSequence: 1,
      dateCreation: horodatage,
      dateCloture: isFin ? horodatage : undefined,
      messages: [],
    };

    const message: MessageChat = {
      echangeId,
      numeroSequence: 1,
      typeMessage,
      niveauSecurite,
      expediteurId: this.id,
      destinataireId,
      texte: premierMessage,
      horodatage,
      numeroSerieCertExpediteur: this.certificatNumeroSerie,
    };

    session.messages.push(message);
    this.echanges.set(echangeId, session);

    this.broker.sendToQueue(`queue.chat.inbox.${destinataireId}`, {
      headers: {
        JMSCorrelationID: echangeId,
        echange_id: echangeId,
        type_message: typeMessage,
        niveau_securite: niveauSecurite,
        expediteur_id: this.id,
        destinataire_id: destinataireId,
        numero_serie_cert_expediteur: this.certificatNumeroSerie ?? null,
        numero_sequence: 1,
        horodatage,
      },
      payload: premierMessage,
    });

    return session;
  }

  public envoyerMessage(
    echangeId: string,
    texte: string,
    options?: EnvoyerMessageOptions
  ): MessageChat {
    const session = this.echanges.get(echangeId);
    if (!session) {
      throw new ExchangeNotFoundError(`Échange inconnu: ${echangeId}`);
    }

    if (session.etat === 'TERMINE') {
      throw new ExchangeClosedError(
        `L'échange ${echangeId} est terminé. Envoi de message impossible.`
      );
    }

    if (
      options?.niveauSecurite &&
      options.niveauSecurite !== session.niveauSecurite
    ) {
      throw new SecurityLevelMismatchError(
        `Niveau de sécurité incompatible: l'échange ${echangeId} est verrouillé en ${session.niveauSecurite}, mais le message tente d'utiliser ${options.niveauSecurite}.`
      );
    }

    const nextSeq =
      options?.numeroSequence ?? (session.dernierNumeroSequence + 1);
    if (nextSeq <= session.dernierNumeroSequence) {
      throw new SequenceNumberError(
        `Numéro de séquence non monotone pour l'échange ${echangeId}: reçu ${nextSeq}, dernier vu ${session.dernierNumeroSequence}.`
      );
    }

    const isFin = texte === 'FIN_MSG' || options?.typeMessage === 'FIN_MSG';
    const typeMessage: TypeMessageChat = isFin
      ? 'FIN_MSG'
      : (options?.typeMessage ?? 'MSG_TEXTE');
    const horodatage = new Date().toISOString();

    session.dernierNumeroSequence = nextSeq;
    if (isFin) {
      session.etat = 'TERMINE';
      session.dateCloture = horodatage;
    }

    const message: MessageChat = {
      echangeId,
      numeroSequence: nextSeq,
      typeMessage,
      niveauSecurite: session.niveauSecurite,
      expediteurId: this.id,
      destinataireId: session.interlocuteurId,
      texte,
      horodatage,
      numeroSerieCertExpediteur: this.certificatNumeroSerie,
    };

    session.messages.push(message);

    this.broker.sendToQueue(`queue.chat.inbox.${session.interlocuteurId}`, {
      headers: {
        JMSCorrelationID: echangeId,
        echange_id: echangeId,
        type_message: typeMessage,
        niveau_securite: session.niveauSecurite,
        expediteur_id: this.id,
        destinataire_id: session.interlocuteurId,
        numero_serie_cert_expediteur: this.certificatNumeroSerie ?? null,
        numero_sequence: nextSeq,
        horodatage,
      },
      payload: texte,
    });

    return message;
  }

  public cloreEchange(echangeId: string): MessageChat {
    return this.envoyerMessage(echangeId, 'FIN_MSG', { typeMessage: 'FIN_MSG' });
  }

  public getEchange(echangeId: string): EchangeSession | undefined {
    return this.echanges.get(echangeId);
  }

  public getEchanges(): EchangeSession[] {
    return Array.from(this.echanges.values());
  }

  public getHistorique(echangeId: string): MessageChat[] {
    const session = this.echanges.get(echangeId);
    return session ? [...session.messages] : [];
  }

  public onMessage(listener: MessageChatListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private traiterMessageEntrant(msg: JmsTextMessage<any>): void {
    const headers = msg.headers || {};
    const echangeId = (headers.JMSCorrelationID ?? headers.echange_id) as string;
    const typeMessage = (headers.type_message ?? 'MSG_TEXTE') as TypeMessageChat;
    const niveauSecurite = (headers.niveau_securite ??
      'NON_SECURISE') as NiveauSecurite;
    const expediteurId = (headers.expediteur_id as string) || '';
    const destinataireId = (headers.destinataire_id as string) || this.id;
    const numeroSequence = Number(headers.numero_sequence ?? 1);
    const horodatage =
      (headers.horodatage as string) || new Date().toISOString();
    const numeroSerieCertExpediteur =
      (headers.numero_serie_cert_expediteur as string) || undefined;
    const numeroSerieCertDestinataire =
      (headers.numero_serie_cert_destinataire as string) || undefined;

    let texte = '';
    if (typeof msg.payload === 'string') {
      texte = msg.payload;
    } else if (msg.payload && typeof msg.payload === 'object') {
      const p = msg.payload as any;
      texte = p.chargeUtile?.contenuTexte ?? p.contenuTexte ?? p.texte ?? '';
    }
    if (!texte && typeof msg.body === 'string') {
      try {
        const parsed = JSON.parse(msg.body);
        texte =
          parsed.chargeUtile?.contenuTexte ??
          parsed.contenuTexte ??
          parsed.texte ??
          msg.body;
      } catch {
        texte = msg.body;
      }
    }

    let session = this.echanges.get(echangeId);

    if (typeMessage === 'INIT_ECHANGE') {
      if (session) {
        if (session.etat === 'TERMINE') {
          throw new ExchangeClosedError(
            `Tentative de réinitialiser l'échange terminé ${echangeId}.`
          );
        }
      } else {
        const isFin = texte === 'FIN_MSG';
        session = {
          echangeId,
          interlocuteurId: expediteurId,
          expediteurInitialId: expediteurId,
          niveauSecurite,
          etat: isFin ? 'TERMINE' : 'ACTIF',
          dernierNumeroSequence: numeroSequence,
          dateCreation: horodatage,
          dateCloture: isFin ? horodatage : undefined,
          messages: [],
        };
        this.echanges.set(echangeId, session);
      }
    } else {
      if (!session) {
        throw new ExchangeNotFoundError(
          `Message reçu pour un échange inconnu: ${echangeId}`
        );
      }

      if (session.etat === 'TERMINE') {
        throw new ExchangeClosedError(
          `Message reçu sur un échange déjà terminé: ${echangeId}`
        );
      }

      if (niveauSecurite !== session.niveauSecurite) {
        throw new SecurityLevelMismatchError(
          `Violation d'invariant de sécurité: le message pour l'échange ${echangeId} a le niveau ${niveauSecurite} mais le niveau verrouillé est ${session.niveauSecurite}.`
        );
      }

      if (numeroSequence <= session.dernierNumeroSequence) {
        throw new SequenceNumberError(
          `Numéro de séquence non monotone pour l'échange ${echangeId}: reçu ${numeroSequence}, dernier vu ${session.dernierNumeroSequence}.`
        );
      }

      session.dernierNumeroSequence = numeroSequence;
      if (typeMessage === 'FIN_MSG' || texte === 'FIN_MSG') {
        session.etat = 'TERMINE';
        session.dateCloture = horodatage;
      }
    }

    const messageChat: MessageChat = {
      echangeId,
      numeroSequence,
      typeMessage: texte === 'FIN_MSG' ? 'FIN_MSG' : typeMessage,
      niveauSecurite,
      expediteurId,
      destinataireId,
      texte,
      horodatage,
      numeroSerieCertExpediteur,
      numeroSerieCertDestinataire,
    };

    session.messages.push(messageChat);

    for (const listener of this.listeners) {
      try {
        listener(messageChat);
      } catch (err) {
        console.error('Erreur dans message listener', err);
      }
    }
  }
}
