import { randomUUID } from 'node:crypto';
import { InMemoryJmsBroker, JmsTextMessage } from '../broker/index.js';
import { ServicePublication } from '../annuaire/index.js';
import {
  AutoriteValidation,
  ServiceAutoriteValidation,
} from '../av/index.js';
import {
  signChatMessage,
  verifyChatMessageSignature,
  encryptChatMessage,
  decryptChatMessage,
} from '../crypto/index.js';
import type { Certificat, UsageCle } from '../types/index.js';
import {
  NiveauSecurite,
  TypeMessageChat,
  MessageChat,
  EchangeSession,
  InitialiserEchangeOptions,
  EnvoyerMessageOptions,
  MessageChatListener,
  CorrespondantClientConfig,
} from './types.js';
import {
  ChatError,
  ExchangeClosedError,
  ExchangeNotFoundError,
  SecurityLevelMismatchError,
  SequenceNumberError,
  CertificateValidationError,
  SignatureVerificationError,
  CertificateStatusError,
  DecryptionError,
} from './errors.js';

export class CorrespondantClient {
  public readonly id: string;
  public broker: InMemoryJmsBroker;
  public certificatNumeroSerie?: string;
  public clePriveePem?: string;
  public clePubliquePem?: string;
  public certificatChiffrementNumeroSerie?: string;
  public clePriveeChiffrementPem?: string;
  public annuaire?: ServicePublication;
  public av?: AutoriteValidation | ServiceAutoriteValidation;

  private echanges = new Map<string, EchangeSession>();
  private listeners = new Set<MessageChatListener>();

  constructor(
    idOrConfig: string | CorrespondantClientConfig,
    broker?: InMemoryJmsBroker,
    certificatNumeroSerie?: string,
    options?: Partial<CorrespondantClientConfig>
  ) {
    if (typeof idOrConfig === 'string') {
      this.id = idOrConfig;
      this.broker = broker!;
      this.certificatNumeroSerie =
        certificatNumeroSerie ?? options?.certificatNumeroSerie;
      this.clePriveePem = options?.clePriveePem;
      this.clePubliquePem = options?.clePubliquePem;
      this.certificatChiffrementNumeroSerie =
        options?.certificatChiffrementNumeroSerie;
      this.clePriveeChiffrementPem = options?.clePriveeChiffrementPem;
      this.annuaire = options?.annuaire;
      this.av = options?.av;
    } else {
      this.id = idOrConfig.id;
      this.broker = idOrConfig.broker;
      this.certificatNumeroSerie = idOrConfig.certificatNumeroSerie;
      this.clePriveePem = idOrConfig.clePriveePem;
      this.clePubliquePem = idOrConfig.clePubliquePem;
      this.certificatChiffrementNumeroSerie =
        idOrConfig.certificatChiffrementNumeroSerie;
      this.clePriveeChiffrementPem = idOrConfig.clePriveeChiffrementPem;
      this.annuaire = idOrConfig.annuaire;
      this.av = idOrConfig.av;
    }

    this.broker.registerQueueConsumer(
      `queue.chat.inbox.${this.id}`,
      (msg) => {
        this.traiterMessageEntrant(msg);
      }
    );
  }

  public setAnnuaire(annuaire: ServicePublication): void {
    this.annuaire = annuaire;
  }

  public setAv(av: AutoriteValidation | ServiceAutoriteValidation): void {
    this.av = av;
  }

  public setCertificat(numeroSerie: string, clePriveePem?: string): void {
    this.certificatNumeroSerie = numeroSerie;
    if (clePriveePem) {
      this.clePriveePem = clePriveePem;
    }
  }

  public setCertificatChiffrement(
    numeroSerie: string,
    clePriveePem?: string
  ): void {
    this.certificatChiffrementNumeroSerie = numeroSerie;
    if (clePriveePem) {
      this.clePriveeChiffrementPem = clePriveePem;
    }
  }

  private getAvInstance(): AutoriteValidation {
    if (!this.av) {
      throw new CertificateValidationError(
        'Autorité de Validation (AV) non configurée sur le client.'
      );
    }
    if (
      'getAvParNature' in this.av &&
      typeof (this.av as any).getAvParNature === 'function'
    ) {
      return (this.av as ServiceAutoriteValidation).getAvParNature(
        'messagerie'
      );
    }
    return this.av as AutoriteValidation;
  }

  private resoudreCertificat(
    sujetId: string,
    usageRequis: 'SIGNATURE' | 'CHIFFREMENT',
    numeroSerieSpecifique?: string
  ): Certificat {
    if (!this.annuaire) {
      throw new CertificateValidationError(
        'Service de Publication (Annuaire) non configuré sur le client.'
      );
    }

    if (numeroSerieSpecifique) {
      const cert = this.annuaire.getCertificatParNumeroSerie(
        numeroSerieSpecifique
      );
      if (!cert) {
        throw new CertificateValidationError(
          `Certificat '${numeroSerieSpecifique}' introuvable dans l'Annuaire.`
        );
      }
      return cert;
    }

    const candidats = this.annuaire.rechercherCertificats({ sujet: sujetId });
    if (candidats.length === 0) {
      throw new CertificateValidationError(
        `Aucun certificat trouvé dans l'Annuaire pour le sujet '${sujetId}'.`
      );
    }

    const correspondant = candidats.find(
      (c) =>
        c.usage === usageRequis || c.usage === 'SIGNATURE_ET_CHIFFREMENT'
    );
    if (!correspondant) {
      throw new CertificateValidationError(
        `Aucun certificat trouvé pour '${sujetId}' autorisant l'usage '${usageRequis}'.`
      );
    }

    return correspondant;
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

    let senderCertSig: Certificat | undefined;
    let senderCertChiffre: Certificat | undefined;
    let recipientCertSig: Certificat | undefined;
    let recipientCertChiffre: Certificat | undefined;

    // Pre-flight AV validation if secured exchange
    if (niveauSecurite !== 'NON_SECURISE') {
      if (!this.annuaire || !this.av) {
        throw new CertificateValidationError(
          'Annuaire et Autorité de Validation (AV) sont requis pour initialiser un échange sécurisé.'
        );
      }
      const avInstance = this.getAvInstance();

      // 1. Resolve and validate sender certificates
      if (niveauSecurite === 'SIGNE' || niveauSecurite === 'SIGNE_ET_CHIFFRE') {
        senderCertSig = this.resoudreCertificat(
          this.id,
          'SIGNATURE',
          this.certificatNumeroSerie
        );
        const valResSig = avInstance.validerCertificat({
          numeroSerieCertificat: senderCertSig.numeroSerie,
          usageAttendu: 'SIGNATURE',
          sujetAttendu: this.id,
        });
        if (!valResSig.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat expéditeur (signature) échouée : ${valResSig.detailsEtapes.messageDiagnostic}`
          );
        }
      }

      if (
        niveauSecurite === 'CHIFFRE' ||
        niveauSecurite === 'SIGNE_ET_CHIFFRE'
      ) {
        senderCertChiffre = this.resoudreCertificat(
          this.id,
          'CHIFFREMENT',
          this.certificatChiffrementNumeroSerie ?? this.certificatNumeroSerie
        );
        const valResChiffre = avInstance.validerCertificat({
          numeroSerieCertificat: senderCertChiffre.numeroSerie,
          usageAttendu: 'CHIFFREMENT',
          sujetAttendu: this.id,
        });
        if (!valResChiffre.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat expéditeur (chiffrement) échouée : ${valResChiffre.detailsEtapes.messageDiagnostic}`
          );
        }
      }

      // If combined in SIGNE_ET_CHIFFRE and same certificate, re-verify combined usage
      if (
        niveauSecurite === 'SIGNE_ET_CHIFFRE' &&
        senderCertSig &&
        senderCertChiffre &&
        senderCertSig.numeroSerie === senderCertChiffre.numeroSerie
      ) {
        const valCombined = avInstance.validerCertificat({
          numeroSerieCertificat: senderCertSig.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: this.id,
        });
        if (!valCombined.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat expéditeur (combiné) échouée : ${valCombined.detailsEtapes.messageDiagnostic}`
          );
        }
      }

      // 2. Resolve and validate recipient certificates
      if (niveauSecurite === 'SIGNE' || niveauSecurite === 'SIGNE_ET_CHIFFRE') {
        recipientCertSig = this.resoudreCertificat(
          destinataireId,
          'SIGNATURE',
          options?.destinataireCertificatNumeroSerie
        );
        const valRecSig = avInstance.validerCertificat({
          numeroSerieCertificat: recipientCertSig.numeroSerie,
          usageAttendu: 'SIGNATURE',
          sujetAttendu: destinataireId,
        });
        if (!valRecSig.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat destinataire (signature) échouée : ${valRecSig.detailsEtapes.messageDiagnostic}`
          );
        }
      }

      if (
        niveauSecurite === 'CHIFFRE' ||
        niveauSecurite === 'SIGNE_ET_CHIFFRE'
      ) {
        recipientCertChiffre = this.resoudreCertificat(
          destinataireId,
          'CHIFFREMENT',
          options?.destinataireCertificatChiffrementNumeroSerie ??
            options?.destinataireCertificatNumeroSerie
        );
        const valRecChiffre = avInstance.validerCertificat({
          numeroSerieCertificat: recipientCertChiffre.numeroSerie,
          usageAttendu: 'CHIFFREMENT',
          sujetAttendu: destinataireId,
        });
        if (!valRecChiffre.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat destinataire (chiffrement) échouée : ${valRecChiffre.detailsEtapes.messageDiagnostic}`
          );
        }
      }

      if (
        niveauSecurite === 'SIGNE_ET_CHIFFRE' &&
        recipientCertSig &&
        recipientCertChiffre &&
        recipientCertSig.numeroSerie === recipientCertChiffre.numeroSerie
      ) {
        const valRecCombined = avInstance.validerCertificat({
          numeroSerieCertificat: recipientCertSig.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: destinataireId,
        });
        if (!valRecCombined.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat destinataire (combiné) échouée : ${valRecCombined.detailsEtapes.messageDiagnostic}`
          );
        }
      }
    }

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
      interlocuteurCertificatNumeroSerie:
        recipientCertSig?.numeroSerie ?? recipientCertChiffre?.numeroSerie ?? null,
      interlocuteurCertificatChiffrementNumeroSerie:
        recipientCertChiffre?.numeroSerie ?? null,
    };

    let payloadToSend: any = premierMessage;
    let signatureExpediteur: string | null = null;
    const certExpediteurSerial =
      senderCertSig?.numeroSerie ??
      senderCertChiffre?.numeroSerie ??
      this.certificatNumeroSerie ??
      null;
    const certDestinataireSerial =
      recipientCertChiffre?.numeroSerie ??
      recipientCertSig?.numeroSerie ??
      null;

    if (niveauSecurite === 'NON_SECURISE') {
      payloadToSend = premierMessage;
    } else if (niveauSecurite === 'SIGNE') {
      if (!this.clePriveePem) {
        throw new CertificateValidationError(
          `Clé privée de signature requise pour expéditeur ${this.id}`
        );
      }
      signatureExpediteur = signChatMessage(
        {
          echangeId,
          numeroSequence: 1,
          horodatage,
          texte: premierMessage,
        },
        this.clePriveePem
      );
      payloadToSend = {
        echangeId,
        numeroSequence: 1,
        typeMessage,
        niveauSecurite,
        expediteur: this.id,
        destinataire: destinataireId,
        horodatage,
        chargeUtile: {
          contenuTexte: premierMessage,
          signatureExpediteur,
          algorithmeSignature: 'SHA256withRSA',
          numeroSerieCertExpediteur: certExpediteurSerial,
          numeroSerieCertDestinataire: certDestinataireSerial,
        },
      };
    } else if (niveauSecurite === 'CHIFFRE') {
      const enc = encryptChatMessage(
        premierMessage,
        recipientCertChiffre!.clePublique
      );
      payloadToSend = {
        echangeId,
        numeroSequence: 1,
        typeMessage,
        niveauSecurite,
        expediteur: this.id,
        destinataire: destinataireId,
        horodatage,
        chargeUtile: {
          contenuTexte: enc.contenuTexte,
          cleSessionChiffreeCpDestinataire:
            enc.cleSessionChiffreeCpDestinataire,
          iv: enc.iv,
          tag: enc.tag,
          algorithmeChiffrement: enc.algorithmeChiffrement,
          numeroSerieCertExpediteur: certExpediteurSerial,
          numeroSerieCertDestinataire: certDestinataireSerial,
        },
      };
    } else if (niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      if (!this.clePriveePem) {
        throw new CertificateValidationError(
          `Clé privée de signature requise pour expéditeur ${this.id}`
        );
      }
      signatureExpediteur = signChatMessage(
        {
          echangeId,
          numeroSequence: 1,
          horodatage,
          texte: premierMessage,
        },
        this.clePriveePem
      );
      const enc = encryptChatMessage(
        premierMessage,
        recipientCertChiffre!.clePublique
      );
      payloadToSend = {
        echangeId,
        numeroSequence: 1,
        typeMessage,
        niveauSecurite,
        expediteur: this.id,
        destinataire: destinataireId,
        horodatage,
        chargeUtile: {
          contenuTexte: enc.contenuTexte,
          cleSessionChiffreeCpDestinataire:
            enc.cleSessionChiffreeCpDestinataire,
          iv: enc.iv,
          tag: enc.tag,
          algorithmeChiffrement: enc.algorithmeChiffrement,
          signatureExpediteur,
          algorithmeSignature: 'SHA256withRSA',
          numeroSerieCertExpediteur: senderCertSig!.numeroSerie,
          numeroSerieCertDestinataire: recipientCertChiffre!.numeroSerie,
        },
      };
    }

    const message: MessageChat = {
      echangeId,
      numeroSequence: 1,
      typeMessage,
      niveauSecurite,
      expediteurId: this.id,
      destinataireId,
      texte: premierMessage,
      horodatage,
      numeroSerieCertExpediteur: certExpediteurSerial,
      numeroSerieCertDestinataire: certDestinataireSerial,
      signature: signatureExpediteur,
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
        numero_serie_cert_expediteur: certExpediteurSerial,
        numero_serie_cert_destinataire: certDestinataireSerial,
        numero_sequence: 1,
        horodatage,
        signature: signatureExpediteur,
      },
      payload: payloadToSend,
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

    let payloadToSend: any = texte;
    let signatureExpediteur: string | null = null;
    let certExpediteurSerial = this.certificatNumeroSerie ?? null;
    let certDestinataireSerial =
      session.interlocuteurCertificatChiffrementNumeroSerie ??
      session.interlocuteurCertificatNumeroSerie ??
      null;

    if (session.niveauSecurite === 'NON_SECURISE') {
      payloadToSend = texte;
    } else if (session.niveauSecurite === 'SIGNE') {
      const senderCert = this.resoudreCertificat(
        this.id,
        'SIGNATURE',
        this.certificatNumeroSerie
      );
      certExpediteurSerial = senderCert.numeroSerie;
      if (!this.clePriveePem) {
        throw new CertificateValidationError(
          `Clé privée de signature requise pour expéditeur ${this.id}`
        );
      }
      signatureExpediteur = signChatMessage(
        {
          echangeId,
          numeroSequence: nextSeq,
          horodatage,
          texte,
        },
        this.clePriveePem
      );
      payloadToSend = {
        echangeId,
        numeroSequence: nextSeq,
        typeMessage,
        niveauSecurite: session.niveauSecurite,
        expediteur: this.id,
        destinataire: session.interlocuteurId,
        horodatage,
        chargeUtile: {
          contenuTexte: texte,
          signatureExpediteur,
          algorithmeSignature: 'SHA256withRSA',
          numeroSerieCertExpediteur: certExpediteurSerial,
          numeroSerieCertDestinataire: certDestinataireSerial,
        },
      };
    } else if (session.niveauSecurite === 'CHIFFRE') {
      const recipientCert = this.resoudreCertificat(
        session.interlocuteurId,
        'CHIFFREMENT',
        session.interlocuteurCertificatChiffrementNumeroSerie ?? undefined
      );
      certDestinataireSerial = recipientCert.numeroSerie;
      const enc = encryptChatMessage(texte, recipientCert.clePublique);
      payloadToSend = {
        echangeId,
        numeroSequence: nextSeq,
        typeMessage,
        niveauSecurite: session.niveauSecurite,
        expediteur: this.id,
        destinataire: session.interlocuteurId,
        horodatage,
        chargeUtile: {
          contenuTexte: enc.contenuTexte,
          cleSessionChiffreeCpDestinataire:
            enc.cleSessionChiffreeCpDestinataire,
          iv: enc.iv,
          tag: enc.tag,
          algorithmeChiffrement: enc.algorithmeChiffrement,
          numeroSerieCertExpediteur: certExpediteurSerial,
          numeroSerieCertDestinataire: certDestinataireSerial,
        },
      };
    } else if (session.niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      const senderCert = this.resoudreCertificat(
        this.id,
        'SIGNATURE',
        this.certificatNumeroSerie
      );
      certExpediteurSerial = senderCert.numeroSerie;
      if (!this.clePriveePem) {
        throw new CertificateValidationError(
          `Clé privée de signature requise pour expéditeur ${this.id}`
        );
      }
      signatureExpediteur = signChatMessage(
        {
          echangeId,
          numeroSequence: nextSeq,
          horodatage,
          texte,
        },
        this.clePriveePem
      );
      const recipientCert = this.resoudreCertificat(
        session.interlocuteurId,
        'CHIFFREMENT',
        session.interlocuteurCertificatChiffrementNumeroSerie ?? undefined
      );
      certDestinataireSerial = recipientCert.numeroSerie;
      const enc = encryptChatMessage(texte, recipientCert.clePublique);
      payloadToSend = {
        echangeId,
        numeroSequence: nextSeq,
        typeMessage,
        niveauSecurite: session.niveauSecurite,
        expediteur: this.id,
        destinataire: session.interlocuteurId,
        horodatage,
        chargeUtile: {
          contenuTexte: enc.contenuTexte,
          cleSessionChiffreeCpDestinataire:
            enc.cleSessionChiffreeCpDestinataire,
          iv: enc.iv,
          tag: enc.tag,
          algorithmeChiffrement: enc.algorithmeChiffrement,
          signatureExpediteur,
          algorithmeSignature: 'SHA256withRSA',
          numeroSerieCertExpediteur: certExpediteurSerial,
          numeroSerieCertDestinataire: certDestinataireSerial,
        },
      };
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
      numeroSerieCertExpediteur: certExpediteurSerial,
      numeroSerieCertDestinataire: certDestinataireSerial,
      signature: signatureExpediteur,
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
        numero_serie_cert_expediteur: certExpediteurSerial,
        numero_serie_cert_destinataire: certDestinataireSerial,
        numero_sequence: nextSeq,
        horodatage,
        signature: signatureExpediteur,
      },
      payload: payloadToSend,
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

    let session = this.echanges.get(echangeId);

    // 1. Invariant & sequence checks
    if (typeMessage === 'INIT_ECHANGE') {
      if (session) {
        if (session.etat === 'TERMINE') {
          throw new ExchangeClosedError(
            `Tentative de réinitialiser l'échange terminé ${echangeId}.`
          );
        }
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
    }

    // 2. Dynamic certificate status check with AV on active secured exchanges
    if (niveauSecurite !== 'NON_SECURISE') {
      const avInstance = this.av ? this.getAvInstance() : undefined;
      if (avInstance && numeroSerieCertExpediteur) {
        const statutRep = avInstance.obtenirStatut(numeroSerieCertExpediteur);
        if (statutRep.statut === 'REVOQUE' || statutRep.statut === 'SUSPENDU') {
          throw new CertificateStatusError(
            `Le certificat de l'expéditeur '${numeroSerieCertExpediteur}' a le statut ${statutRep.statut} auprès de l'AV. Message rejeté.`
          );
        }
        if (statutRep.statut === 'INCONNU') {
          throw new CertificateStatusError(
            `Le certificat de l'expéditeur '${numeroSerieCertExpediteur}' est inconnu auprès de l'AV. Message rejeté.`
          );
        }
      }
    }

    // 3. Pre-flight 4-step validation of sender cert upon INIT_ECHANGE reception
    if (typeMessage === 'INIT_ECHANGE' && !session && niveauSecurite !== 'NON_SECURISE') {
      if (this.av && numeroSerieCertExpediteur) {
        const avInstance = this.getAvInstance();
        const usageAttendu: UsageCle =
          niveauSecurite === 'SIGNE'
            ? 'SIGNATURE'
            : niveauSecurite === 'CHIFFRE'
            ? 'CHIFFREMENT'
            : 'SIGNATURE';
        const valRes = avInstance.validerCertificat({
          numeroSerieCertificat: numeroSerieCertExpediteur,
          usageAttendu,
          sujetAttendu: expediteurId,
        });
        if (!valRes.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat expéditeur '${numeroSerieCertExpediteur}' échouée : ${valRes.detailsEtapes.messageDiagnostic}`
          );
        }
      }
    }

    // 4. Extract payload & decrypt if encrypted
    let chargeUtile: any = undefined;
    if (msg.payload && typeof msg.payload === 'object') {
      chargeUtile = msg.payload.chargeUtile ?? msg.payload;
    } else if (msg.body && typeof msg.body === 'string') {
      try {
        const parsed = JSON.parse(msg.body);
        chargeUtile = parsed.chargeUtile ?? parsed;
      } catch {
        // Not a JSON body
      }
    }

    let texteClair = '';
    if (niveauSecurite === 'CHIFFRE' || niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      if (!chargeUtile) {
        throw new DecryptionError('Charge utile chiffrée absente');
      }
      const decryptKey =
        this.clePriveeChiffrementPem ?? this.clePriveePem;
      if (!decryptKey) {
        throw new DecryptionError(
          `Clé privée de déchiffrement manquante pour le correspondant ${this.id}`
        );
      }
      try {
        texteClair = decryptChatMessage(chargeUtile, decryptKey);
      } catch (err: any) {
        throw new DecryptionError(
          `Échec du déchiffrement du message : ${err?.message ?? err}`
        );
      }
    } else {
      texteClair =
        chargeUtile?.contenuTexte ??
        (typeof msg.payload === 'string' ? msg.payload : msg.body ?? '');
    }

    // 5. Digital signature verification for SIGNE and SIGNE_ET_CHIFFRE
    if (niveauSecurite === 'SIGNE' || niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      const signature =
        (headers.signature as string) ?? chargeUtile?.signatureExpediteur;
      if (!signature) {
        throw new SignatureVerificationError(
          `Signature absente pour le message de l'échange ${echangeId}.`
        );
      }

      const certSerial =
        numeroSerieCertExpediteur ??
        chargeUtile?.numeroSerieCertExpediteur;
      if (!certSerial) {
        throw new SignatureVerificationError(
          'Numéro de série du certificat expéditeur manquant pour vérifier la signature.'
        );
      }

      if (!this.annuaire) {
        throw new SignatureVerificationError(
          'Annuaire non configuré pour résoudre la clé publique de l\'expéditeur.'
        );
      }

      const senderCert = this.annuaire.getCertificatParNumeroSerie(certSerial);
      if (!senderCert) {
        throw new SignatureVerificationError(
          `Certificat expéditeur '${certSerial}' introuvable dans l'Annuaire.`
        );
      }

      const signatureValide = verifyChatMessageSignature(
        {
          echangeId,
          numeroSequence,
          horodatage,
          texte: texteClair,
        },
        signature,
        senderCert.clePublique
      );

      if (!signatureValide) {
        throw new SignatureVerificationError(
          `Signature invalide ou message corrompu/altéré pour l'échange ${echangeId}.`
        );
      }
    }

    // 6. Record session state
    const isFin = texteClair === 'FIN_MSG' || typeMessage === 'FIN_MSG';

    if (typeMessage === 'INIT_ECHANGE') {
      if (!session) {
        let interlocuteurCertChiffrement: string | undefined = undefined;
        if (
          niveauSecurite === 'CHIFFRE' ||
          niveauSecurite === 'SIGNE_ET_CHIFFRE'
        ) {
          try {
            const chCert = this.resoudreCertificat(
              expediteurId,
              'CHIFFREMENT'
            );
            interlocuteurCertChiffrement = chCert.numeroSerie;
          } catch {
            interlocuteurCertChiffrement = numeroSerieCertExpediteur;
          }
        }

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
          interlocuteurCertificatNumeroSerie: numeroSerieCertExpediteur,
          interlocuteurCertificatChiffrementNumeroSerie:
            interlocuteurCertChiffrement,
        };
        this.echanges.set(echangeId, session);
      }
    } else {
      session!.dernierNumeroSequence = numeroSequence;
      if (isFin) {
        session!.etat = 'TERMINE';
        session!.dateCloture = horodatage;
      }
    }

    const messageChat: MessageChat = {
      echangeId,
      numeroSequence,
      typeMessage: isFin ? 'FIN_MSG' : typeMessage,
      niveauSecurite,
      expediteurId,
      destinataireId,
      texte: texteClair,
      horodatage,
      numeroSerieCertExpediteur,
      numeroSerieCertDestinataire,
      signature:
        (headers.signature as string) ?? chargeUtile?.signatureExpediteur ?? null,
    };

    session!.messages.push(messageChat);

    for (const listener of this.listeners) {
      try {
        listener(messageChat);
      } catch (err) {
        console.error('Erreur dans message listener', err);
      }
    }
  }
}
