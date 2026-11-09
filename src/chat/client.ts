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

  private validerCertificatCorrespondant(
    correspondantId: string,
    niveauSecurite: NiveauSecurite,
    options?: {
      certificatNumeroSerie?: string;
      certificatChiffrementNumeroSerie?: string;
    }
  ): {
    certSignature?: Certificat;
    certChiffrement?: Certificat;
  } {
    if (niveauSecurite === 'NON_SECURISE') {
      return {};
    }

    if (!this.annuaire || !this.av) {
      throw new CertificateValidationError(
        'Annuaire et Autorité de Validation (AV) sont requis pour valider les certificats sécurisés.'
      );
    }
    const avInstance = this.getAvInstance();

    let certSig: Certificat | undefined;
    let certChiffre: Certificat | undefined;

    if (niveauSecurite === 'SIGNE') {
      certSig = this.resoudreCertificat(
        correspondantId,
        'SIGNATURE',
        options?.certificatNumeroSerie
      );
      const valRes = avInstance.validerCertificat({
        numeroSerieCertificat: certSig.numeroSerie,
        usageAttendu: 'SIGNATURE',
        sujetAttendu: correspondantId,
      });
      if (!valRes.valide) {
        throw new CertificateValidationError(
          `Validation AV préalable du certificat correspondant (${correspondantId}, signature) échouée : ${valRes.detailsEtapes.messageDiagnostic}`
        );
      }
      return { certSignature: certSig };
    }

    if (niveauSecurite === 'CHIFFRE') {
      certChiffre = this.resoudreCertificat(
        correspondantId,
        'CHIFFREMENT',
        options?.certificatChiffrementNumeroSerie ?? options?.certificatNumeroSerie
      );
      const valRes = avInstance.validerCertificat({
        numeroSerieCertificat: certChiffre.numeroSerie,
        usageAttendu: 'CHIFFREMENT',
        sujetAttendu: correspondantId,
      });
      if (!valRes.valide) {
        throw new CertificateValidationError(
          `Validation AV préalable du certificat correspondant (${correspondantId}, chiffrement) échouée : ${valRes.detailsEtapes.messageDiagnostic}`
        );
      }
      return { certChiffrement: certChiffre };
    }

    if (niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      // Check if a specific cert was supplied that satisfies SIGNATURE_ET_CHIFFREMENT
      if (options?.certificatNumeroSerie) {
        const cert = this.annuaire.getCertificatParNumeroSerie(options.certificatNumeroSerie);
        if (cert && cert.usage === 'SIGNATURE_ET_CHIFFREMENT') {
          certSig = cert;
          certChiffre = cert;
        }
      }

      if (!certSig || !certChiffre) {
        // Resolve signature certificate
        certSig = this.resoudreCertificat(
          correspondantId,
          'SIGNATURE',
          options?.certificatNumeroSerie
        );
        // Resolve encryption certificate
        certChiffre = this.resoudreCertificat(
          correspondantId,
          'CHIFFREMENT',
          options?.certificatChiffrementNumeroSerie ??
            (options?.certificatNumeroSerie && options.certificatNumeroSerie !== certSig.numeroSerie
              ? options.certificatNumeroSerie
              : undefined)
        );
      }

      if (certSig.numeroSerie === certChiffre.numeroSerie) {
        const valRes = avInstance.validerCertificat({
          numeroSerieCertificat: certSig.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: correspondantId,
        });
        if (!valRes.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat correspondant (${correspondantId}, combiné) échouée : ${valRes.detailsEtapes.messageDiagnostic}`
          );
        }
      } else {
        const valSig = avInstance.validerCertificat({
          numeroSerieCertificat: certSig.numeroSerie,
          usageAttendu: 'SIGNATURE',
          sujetAttendu: correspondantId,
        });
        if (!valSig.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat correspondant (${correspondantId}, signature) échouée : ${valSig.detailsEtapes.messageDiagnostic}`
          );
        }

        const valChiffre = avInstance.validerCertificat({
          numeroSerieCertificat: certChiffre.numeroSerie,
          usageAttendu: 'CHIFFREMENT',
          sujetAttendu: correspondantId,
        });
        if (!valChiffre.valide) {
          throw new CertificateValidationError(
            `Validation AV préalable du certificat correspondant (${correspondantId}, chiffrement) échouée : ${valChiffre.detailsEtapes.messageDiagnostic}`
          );
        }
      }

      return { certSignature: certSig, certChiffrement: certChiffre };
    }

    return {};
  }

  private preparerChargeUtileEtSignature(params: {
    echangeId: string;
    numeroSequence: number;
    typeMessage: TypeMessageChat;
    niveauSecurite: NiveauSecurite;
    texte: string;
    horodatage: string;
    destinataireId: string;
    clePriveeSignaturePem?: string;
    clePubliqueDestinataire?: string;
    certExpediteurSerial?: string | null;
    certDestinataireSerial?: string | null;
  }): {
    payloadToSend: any;
    signatureExpediteur: string | null;
  } {
    const {
      echangeId,
      numeroSequence,
      typeMessage,
      niveauSecurite,
      texte,
      horodatage,
      destinataireId,
      clePriveeSignaturePem,
      clePubliqueDestinataire,
      certExpediteurSerial,
      certDestinataireSerial,
    } = params;

    if (niveauSecurite === 'NON_SECURISE') {
      return {
        payloadToSend: texte,
        signatureExpediteur: null,
      };
    }

    if (niveauSecurite === 'SIGNE') {
      if (!clePriveeSignaturePem) {
        throw new CertificateValidationError(
          `Clé privée de signature requise pour expéditeur ${this.id}`
        );
      }
      const signatureExpediteur = signChatMessage(
        {
          echangeId,
          numeroSequence,
          horodatage,
          texte,
        },
        clePriveeSignaturePem
      );
      const payloadToSend = {
        echangeId,
        numeroSequence,
        typeMessage,
        niveauSecurite,
        expediteur: this.id,
        destinataire: destinataireId,
        horodatage,
        chargeUtile: {
          contenuTexte: texte,
          signatureExpediteur,
          algorithmeSignature: 'SHA256withRSA',
          numeroSerieCertExpediteur: certExpediteurSerial ?? null,
          numeroSerieCertDestinataire: certDestinataireSerial ?? null,
        },
      };
      return { payloadToSend, signatureExpediteur };
    }

    if (niveauSecurite === 'CHIFFRE') {
      if (!clePubliqueDestinataire) {
        throw new CertificateValidationError(
          `Clé publique de chiffrement du destinataire ${destinataireId} requise`
        );
      }
      const enc = encryptChatMessage(texte, clePubliqueDestinataire);
      const payloadToSend = {
        echangeId,
        numeroSequence,
        typeMessage,
        niveauSecurite,
        expediteur: this.id,
        destinataire: destinataireId,
        horodatage,
        chargeUtile: {
          contenuTexte: enc.contenuTexte,
          cleSessionChiffreeCpDestinataire: enc.cleSessionChiffreeCpDestinataire,
          iv: enc.iv,
          tag: enc.tag,
          algorithmeChiffrement: enc.algorithmeChiffrement,
          numeroSerieCertExpediteur: certExpediteurSerial ?? null,
          numeroSerieCertDestinataire: certDestinataireSerial ?? null,
        },
      };
      return { payloadToSend, signatureExpediteur: null };
    }

    if (niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      if (!clePriveeSignaturePem) {
        throw new CertificateValidationError(
          `Clé privée de signature requise pour expéditeur ${this.id}`
        );
      }
      if (!clePubliqueDestinataire) {
        throw new CertificateValidationError(
          `Clé publique de chiffrement du destinataire ${destinataireId} requise`
        );
      }
      const signatureExpediteur = signChatMessage(
        {
          echangeId,
          numeroSequence,
          horodatage,
          texte,
        },
        clePriveeSignaturePem
      );
      const enc = encryptChatMessage(texte, clePubliqueDestinataire);
      const payloadToSend = {
        echangeId,
        numeroSequence,
        typeMessage,
        niveauSecurite,
        expediteur: this.id,
        destinataire: destinataireId,
        horodatage,
        chargeUtile: {
          contenuTexte: enc.contenuTexte,
          cleSessionChiffreeCpDestinataire: enc.cleSessionChiffreeCpDestinataire,
          iv: enc.iv,
          tag: enc.tag,
          algorithmeChiffrement: enc.algorithmeChiffrement,
          signatureExpediteur,
          algorithmeSignature: 'SHA256withRSA',
          numeroSerieCertExpediteur: certExpediteurSerial ?? null,
          numeroSerieCertDestinataire: certDestinataireSerial ?? null,
        },
      };
      return { payloadToSend, signatureExpediteur };
    }

    return { payloadToSend: texte, signatureExpediteur: null };
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

    // Pre-flight AV validation if secured exchange
    const senderCerts = this.validerCertificatCorrespondant(this.id, niveauSecurite, {
      certificatNumeroSerie: this.certificatNumeroSerie,
      certificatChiffrementNumeroSerie:
        this.certificatChiffrementNumeroSerie ?? this.certificatNumeroSerie,
    });

    const recipientCerts = this.validerCertificatCorrespondant(
      destinataireId,
      niveauSecurite,
      {
        certificatNumeroSerie: options?.destinataireCertificatNumeroSerie,
        certificatChiffrementNumeroSerie:
          options?.destinataireCertificatChiffrementNumeroSerie ??
          options?.destinataireCertificatNumeroSerie,
      }
    );

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
        recipientCerts.certSignature?.numeroSerie ??
        recipientCerts.certChiffrement?.numeroSerie ??
        null,
      interlocuteurCertificatChiffrementNumeroSerie:
        recipientCerts.certChiffrement?.numeroSerie ?? null,
    };

    const certExpediteurSerial =
      senderCerts.certSignature?.numeroSerie ??
      senderCerts.certChiffrement?.numeroSerie ??
      this.certificatNumeroSerie ??
      null;
    const certDestinataireSerial =
      recipientCerts.certChiffrement?.numeroSerie ??
      recipientCerts.certSignature?.numeroSerie ??
      null;

    const { payloadToSend, signatureExpediteur } =
      this.preparerChargeUtileEtSignature({
        echangeId,
        numeroSequence: 1,
        typeMessage,
        niveauSecurite,
        texte: premierMessage,
        horodatage,
        destinataireId,
        clePriveeSignaturePem: this.clePriveePem,
        clePubliqueDestinataire: recipientCerts.certChiffrement?.clePublique,
        certExpediteurSerial,
        certDestinataireSerial,
      });

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

    let certExpediteurSerial = this.certificatNumeroSerie ?? null;
    let certDestinataireSerial =
      session.interlocuteurCertificatChiffrementNumeroSerie ??
      session.interlocuteurCertificatNumeroSerie ??
      null;
    let destinataireClePublique: string | undefined = undefined;

    if (session.niveauSecurite === 'SIGNE') {
      const senderCert = this.resoudreCertificat(
        this.id,
        'SIGNATURE',
        this.certificatNumeroSerie
      );
      certExpediteurSerial = senderCert.numeroSerie;
    } else if (session.niveauSecurite === 'CHIFFRE') {
      const recipientCert = this.resoudreCertificat(
        session.interlocuteurId,
        'CHIFFREMENT',
        session.interlocuteurCertificatChiffrementNumeroSerie ?? undefined
      );
      certDestinataireSerial = recipientCert.numeroSerie;
      destinataireClePublique = recipientCert.clePublique;
    } else if (session.niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      const senderCert = this.resoudreCertificat(
        this.id,
        'SIGNATURE',
        this.certificatNumeroSerie
      );
      certExpediteurSerial = senderCert.numeroSerie;
      const recipientCert = this.resoudreCertificat(
        session.interlocuteurId,
        'CHIFFREMENT',
        session.interlocuteurCertificatChiffrementNumeroSerie ?? undefined
      );
      certDestinataireSerial = recipientCert.numeroSerie;
      destinataireClePublique = recipientCert.clePublique;
    }

    const { payloadToSend, signatureExpediteur } =
      this.preparerChargeUtileEtSignature({
        echangeId,
        numeroSequence: nextSeq,
        typeMessage,
        niveauSecurite: session.niveauSecurite,
        texte,
        horodatage,
        destinataireId: session.interlocuteurId,
        clePriveeSignaturePem: this.clePriveePem,
        clePubliqueDestinataire: destinataireClePublique,
        certExpediteurSerial,
        certDestinataireSerial,
      });

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
      if (this.av) {
        this.validerCertificatCorrespondant(expediteurId, niveauSecurite, {
          certificatNumeroSerie: numeroSerieCertExpediteur,
        });
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
