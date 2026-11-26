import { randomUUID } from 'node:crypto';
import {
  canonicalJson,
  decryptHybridMessage,
  encryptHybridMessage,
  signMessageText,
  verifyMessageSignature
} from '../crypto/index.js';
import type {
  Certificat,
  NatureRessource,
  UsageCle,
  ValidationCertificatReponse
} from '../types/index.js';
import type { UtilisateurIcpClient } from '../client/utilisateur-icp.js';
import {
  ErreurMessagerie,
  ErreurSecuriteEchange,
  ErreurSequenceMessage,
  ErreurSessionFermee,
  ErreurValidationCorrespondant
} from './errors.js';
import type {
  ChatAmqpTransport,
  CorrespondantClientConfig,
  EnveloppeChatAmqp,
  ErreurReceptionChat,
  MessageChatPayload,
  MessageEnvoye,
  MessageRecu,
  NiveauSecurite,
  OptionsEnvoiMessage,
  OptionsOuvertureEchange,
  SessionEchangeState,
  TypeMessageChat
} from './types.js';

const CODE_CLOTURE_FIN_MSG = 'FIN_MSG';

interface BicleLocale {
  certificat: Certificat;
  clePrivee: string;
}

interface CertificatsValidesEchange {
  propreSignature?: BicleLocale;
  propreChiffrement?: BicleLocale;
  distantSignature?: Certificat;
  distantChiffrement?: Certificat;
}

interface ChargeSigneeEtChiffree {
  contenu: string;
  signature: string;
  numeroSerieCertificatSignature: string;
}

function cloneSession(session: SessionEchangeState): SessionEchangeState {
  return {
    ...session,
    sequencesRecuesParEmetteur: { ...session.sequencesRecuesParEmetteur }
  };
}

function estUsageCompatible(
  usageCert: UsageCle,
  usageAttendu: 'SIGNATURE' | 'CHIFFREMENT'
): boolean {
  return usageCert === usageAttendu || usageCert === 'SIGNATURE_ET_CHIFFREMENT';
}

function construireDonneesSignees(params: {
  echangeId: string;
  numeroSequence: number;
  typeMessage: TypeMessageChat;
  niveauSecurite: NiveauSecurite;
  emetteurId: string;
  correspondantRecepteurId: string;
  horodatage: string;
  contenu: string;
}): string {
  return canonicalJson(params);
}

function codeErreurValidation(rapport: ValidationCertificatReponse): string {
  if (!rapport.detailsEtapes.etape1ValiditeTemporelle) {
    return 'CERTIFICAT_EXPIRE_OU_NON_VALIDE';
  }
  if (!rapport.detailsEtapes.etape2ChaineEtSignatures) {
    return 'CHAINE_CERTIFICATION_INVALIDE';
  }
  if (!rapport.detailsEtapes.etape3StatutAv) {
    if (rapport.statutCourant === 'REVOQUE') {
      return 'CERTIFICAT_REVOQUE';
    }
    if (rapport.statutCourant === 'SUSPENDU') {
      return 'CERTIFICAT_SUSPENDU';
    }
    return 'CERTIFICAT_STATUT_INVALIDE';
  }
  if (!rapport.detailsEtapes.etape4PolitiqueUsageEtSujet) {
    return 'USAGE_OU_SUJET_INCOMPATIBLE';
  }
  return 'VALIDATION_CERTIFICAT_ECHOUEE';
}

function verifierCoherenceFinMsg(
  typeMessage: TypeMessageChat,
  texteClair: string
): boolean {
  const estFinMsg = texteClair === CODE_CLOTURE_FIN_MSG;
  if (typeMessage === 'FIN_MSG' && !estFinMsg) {
    throw new ErreurSecuriteEchange(
      'FIN_MSG_INCOHERENT',
      'Un message de type FIN_MSG doit contenir uniquement le code texte "FIN_MSG".'
    );
  }
  return estFinMsg;
}

/**
 * Client Correspondant de messagerie texte sécurisée sur AMQP 0-9-1,
 * agissant à la fois comme Porteur (clé privée / certificat) et Utilisateur ICP
 * (validation en 4 étapes et contrôle dynamique AV).
 */
export class CorrespondantClient {
  readonly correspondantId: string;
  readonly natureRessource: NatureRessource;

  private readonly transport: ChatAmqpTransport;
  private readonly utilisateurIcp: UtilisateurIcpClient;
  private readonly config: CorrespondantClientConfig;
  private readonly horloge: () => Date;

  private readonly sessions = new Map<string, SessionEchangeState>();
  private readonly messagesRecus: MessageRecu[] = [];
  private readonly erreursRecues: ErreurReceptionChat[] = [];
  private readonly messageListeners = new Set<(message: MessageRecu) => void | Promise<void>>();
  private readonly erreurListeners = new Set<(erreur: ErreurReceptionChat) => void | Promise<void>>();

  private consumerTag: string | null = null;
  private initPromise: Promise<void> | null = null;

  constructor(config: CorrespondantClientConfig) {
    this.correspondantId = config.correspondantId;
    this.natureRessource = config.natureRessource ?? 'messagerie';
    this.transport = config.transport;
    this.utilisateurIcp = config.utilisateurIcp;
    this.config = config;
    this.horloge = config.horloge ?? (() => new Date());

    if (config.autoAbonnement ?? true) {
      this.initPromise = this.demarrer();
    }
  }

  async demarrer(): Promise<void> {
    if (this.consumerTag !== null) {
      return;
    }
    this.consumerTag = await this.transport.abonnerBoiteReception(
      this.correspondantId,
      async (enveloppe) => {
        await this.traiterEnveloppeAmqp(enveloppe);
      }
    );
  }

  async ready(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
      return;
    }
    await this.demarrer();
  }

  async arreter(): Promise<void> {
    if (this.initPromise) {
      await this.initPromise;
    }
    if (this.consumerTag !== null && this.transport.desabonnerBoiteReception) {
      this.transport.desabonnerBoiteReception(this.correspondantId, this.consumerTag);
      this.consumerTag = null;
    }
  }

  onMessage(listener: (message: MessageRecu) => void | Promise<void>): () => void {
    this.messageListeners.add(listener);
    return () => {
      this.messageListeners.delete(listener);
    };
  }

  onErreur(listener: (erreur: ErreurReceptionChat) => void | Promise<void>): () => void {
    this.erreurListeners.add(listener);
    return () => {
      this.erreurListeners.delete(listener);
    };
  }

  getMessagesRecus(): MessageRecu[] {
    return this.messagesRecus.map((m) => ({ ...m }));
  }

  getErreurs(): ErreurReceptionChat[] {
    return this.erreursRecues.map((e) => ({ ...e }));
  }

  getSession(echangeId: string): SessionEchangeState | undefined {
    const session = this.sessions.get(echangeId);
    return session ? cloneSession(session) : undefined;
  }

  listerSessions(): SessionEchangeState[] {
    return Array.from(this.sessions.values()).map(cloneSession);
  }

  async ouvrirEchange(
    correspondantRecepteurId: string,
    niveauSecurite: NiveauSecurite,
    contenuInitial: string,
    options: OptionsOuvertureEchange = {}
  ): Promise<MessageEnvoye> {
    const echangeId = options.echangeId ?? randomUUID();
    if (this.sessions.has(echangeId)) {
      throw new ErreurSessionFermee(
        'SESSION_DEJA_OUVERTE',
        `Un Échange avec l'identifiant "${echangeId}" existe déjà.`
      );
    }
    if (!correspondantRecepteurId) {
      throw new ErreurMessagerie(
        'CORRESPONDANT_RECEPTEUR_INVALIDE',
        'L’identifiant du Correspondant récepteur est obligatoire.'
      );
    }

    const certs = await this.validerCertificatsPourEchange(
      correspondantRecepteurId,
      niveauSecurite,
      {
        signatureNumeroSerie:
          options.numeroSerieCertificatSignatureCorrespondantRecepteur ??
          options.numeroSerieCertificatCorrespondantRecepteur,
        chiffrementNumeroSerie:
          options.numeroSerieCertificatChiffrementCorrespondantRecepteur ??
          options.numeroSerieCertificatCorrespondantRecepteur
      }
    );

    const horodatage = this.horloge().toISOString();
    const numeroSequence = 1;
    const typeMessage: TypeMessageChat = 'INIT_ECHANGE';
    const sessionFermee = contenuInitial === CODE_CLOTURE_FIN_MSG;

    const session: SessionEchangeState = {
      echangeId,
      correspondantDistantId: correspondantRecepteurId,
      niveauSecurite,
      statut: 'ACTIVE',
      initiateurId: this.correspondantId,
      dernierNumeroSequenceEnvoye: 0,
      dernierNumeroSequenceRecu: 0,
      sequencesRecuesParEmetteur: {},
      ...(certs.distantSignature
        ? { certificatDistantSignatureNumeroSerie: certs.distantSignature.numeroSerie }
        : {}),
      ...(certs.distantChiffrement
        ? { certificatDistantChiffrementNumeroSerie: certs.distantChiffrement.numeroSerie }
        : {}),
      horodatageOuverture: horodatage
    };

    const payload = this.construirePayloadSortant({
      echangeId,
      numeroSequence,
      typeMessage,
      niveauSecurite,
      correspondantRecepteurId,
      horodatage,
      contenu: contenuInitial,
      certs
    });

    this.sessions.set(echangeId, session);
    try {
      await this.publierPayload(correspondantRecepteurId, payload);
      session.dernierNumeroSequenceEnvoye = numeroSequence;
      if (sessionFermee) {
        session.statut = 'FERMEE';
        session.horodatageCloture = horodatage;
      }
    } catch (err) {
      this.sessions.delete(echangeId);
      throw err;
    }

    return {
      echangeId,
      numeroSequence,
      typeMessage,
      niveauSecurite,
      emetteurId: this.correspondantId,
      correspondantRecepteurId,
      horodatage,
      sessionFermee: session.statut === 'FERMEE'
    };
  }

  async envoyerMessage(
    echangeId: string,
    contenu: string,
    options: OptionsEnvoiMessage = {}
  ): Promise<MessageEnvoye> {
    const session = this.sessions.get(echangeId);
    if (!session) {
      throw new ErreurSessionFermee(
        'SESSION_INTROUVABLE',
        `Aucun Échange actif trouvé pour "${echangeId}".`
      );
    }
    if (session.statut === 'FERMEE') {
      throw new ErreurSessionFermee(
        'SESSION_FERMEE',
        `L'Échange "${echangeId}" est définitivement clos (FIN_MSG).`
      );
    }
    if (
      options.niveauSecurite !== undefined &&
      options.niveauSecurite !== session.niveauSecurite
    ) {
      throw new ErreurSecuriteEchange(
        'NIVEAU_SECURITE_IMMUABLE',
        `Impossible de modifier le Niveau de sécurité verrouillé "${session.niveauSecurite}" vers "${options.niveauSecurite}" sur l'Échange "${echangeId}".`
      );
    }

    const certs = await this.validerCertificatsPourEchange(
      session.correspondantDistantId,
      session.niveauSecurite,
      {
        signatureNumeroSerie: session.certificatDistantSignatureNumeroSerie,
        chiffrementNumeroSerie: session.certificatDistantChiffrementNumeroSerie
      }
    );

    const horodatage = this.horloge().toISOString();
    const numeroSequence = session.dernierNumeroSequenceEnvoye + 1;
    const estCloture = contenu === CODE_CLOTURE_FIN_MSG;
    const typeMessage: TypeMessageChat = estCloture ? 'FIN_MSG' : 'MSG_TEXTE';

    const payload = this.construirePayloadSortant({
      echangeId,
      numeroSequence,
      typeMessage,
      niveauSecurite: session.niveauSecurite,
      correspondantRecepteurId: session.correspondantDistantId,
      horodatage,
      contenu,
      certs
    });

    await this.publierPayload(session.correspondantDistantId, payload);
    session.dernierNumeroSequenceEnvoye = numeroSequence;
    if (estCloture) {
      session.statut = 'FERMEE';
      session.horodatageCloture = horodatage;
    }

    return {
      echangeId,
      numeroSequence,
      typeMessage,
      niveauSecurite: session.niveauSecurite,
      emetteurId: this.correspondantId,
      correspondantRecepteurId: session.correspondantDistantId,
      horodatage,
      sessionFermee: session.statut === 'FERMEE'
    };
  }

  async cloreEchange(echangeId: string): Promise<MessageEnvoye> {
    return this.envoyerMessage(echangeId, CODE_CLOTURE_FIN_MSG);
  }

  async traiterEnveloppeAmqp(enveloppe: EnveloppeChatAmqp): Promise<MessageRecu> {
    try {
      const message = await this.validerEtDecoderEnveloppe(enveloppe);
      this.messagesRecus.push(message);
      for (const listener of this.messageListeners) {
        await listener({ ...message });
      }
      return message;
    } catch (err) {
      const erreur = err instanceof Error ? err : new Error(String(err));
      const incident: ErreurReceptionChat = {
        erreur,
        enveloppe,
        horodatage: this.horloge().toISOString()
      };
      this.erreursRecues.push(incident);
      for (const listener of this.erreurListeners) {
        await listener(incident);
      }
      throw erreur;
    }
  }

  private resoudreBicleLocale(usage: 'SIGNATURE' | 'CHIFFREMENT'): BicleLocale {
    const certificat =
      usage === 'SIGNATURE'
        ? (this.config.certificatSignature ?? this.config.certificat)
        : (this.config.certificatChiffrement ?? this.config.certificat);

    const clePrivee =
      usage === 'SIGNATURE'
        ? (this.config.clePriveeSignature ?? this.config.clePrivee)
        : (this.config.clePriveeChiffrement ?? this.config.clePrivee);

    if (!certificat || !clePrivee) {
      throw new ErreurValidationCorrespondant(
        'CERTIFICAT_LOCAL_MANQUANT',
        `Le Correspondant "${this.correspondantId}" ne dispose pas d'une Biclé locale pour l'usage "${usage}".`
      );
    }

    if (certificat.sujet !== this.correspondantId) {
      throw new ErreurValidationCorrespondant(
        'SUJET_CERTIFICAT_LOCAL_INCOMPATIBLE',
        `Le certificat "${certificat.numeroSerie}" appartient à "${certificat.sujet}" et non à "${this.correspondantId}".`
      );
    }

    if (!estUsageCompatible(certificat.usage, usage)) {
      throw new ErreurValidationCorrespondant(
        'USAGE_CERTIFICAT_LOCAL_INCOMPATIBLE',
        `Usage "${certificat.usage}" du certificat "${certificat.numeroSerie}" incompatible avec "${usage}".`
      );
    }

    return { certificat, clePrivee };
  }

  private async validerCertificatEn4Etapes(
    numeroSerie: string,
    usageAttendu: 'SIGNATURE' | 'CHIFFREMENT',
    sujetAttendu: string
  ): Promise<Certificat> {
    const rapport = await this.utilisateurIcp.validerCertificat({
      numeroSerieCertificat: numeroSerie,
      natureRessource: this.natureRessource,
      usageAttendu,
      sujetAttendu
    });

    if (!rapport.valide || rapport.cheminCertification.length === 0) {
      throw new ErreurValidationCorrespondant(
        codeErreurValidation(rapport),
        rapport.detailsEtapes.messageDiagnostic,
        rapport
      );
    }

    return rapport.cheminCertification[0]!;
  }

  private async resoudreEtValiderCertificatDistant(
    correspondantDistantId: string,
    usageAttendu: 'SIGNATURE' | 'CHIFFREMENT',
    numeroSerieExplicite?: string
  ): Promise<Certificat> {
    if (numeroSerieExplicite) {
      return this.validerCertificatEn4Etapes(
        numeroSerieExplicite,
        usageAttendu,
        correspondantDistantId
      );
    }

    const certificatsSujet = await this.utilisateurIcp.rechercherCertificats({
      sujet: correspondantDistantId,
      uniquementValides: false
    });

    if (certificatsSujet.length === 0) {
      throw new ErreurValidationCorrespondant(
        'CERTIFICAT_CORRESPONDANT_INCONNU',
        `Aucun certificat trouvé dans l'annuaire pour "${correspondantDistantId}".`
      );
    }

    const compatibles = certificatsSujet.filter((c) =>
      estUsageCompatible(c.usage, usageAttendu)
    );

    if (compatibles.length === 0) {
      // Déclenche la validation réglementaire étape 4 sur le certificat présent pour produire un diagnostic complet
      return this.validerCertificatEn4Etapes(
        certificatsSujet[0]!.numeroSerie,
        usageAttendu,
        correspondantDistantId
      );
    }

    let premiereErreur: ErreurValidationCorrespondant | null = null;
    for (const candidat of compatibles) {
      try {
        return await this.validerCertificatEn4Etapes(
          candidat.numeroSerie,
          usageAttendu,
          correspondantDistantId
        );
      } catch (err) {
        if (err instanceof ErreurValidationCorrespondant && !premiereErreur) {
          premiereErreur = err;
        }
      }
    }

    throw (
      premiereErreur ??
      new ErreurValidationCorrespondant(
        'VALIDATION_CERTIFICAT_ECHOUEE',
        `Impossible de valider un certificat "${usageAttendu}" pour "${correspondantDistantId}".`
      )
    );
  }

  private async validerCertificatsPourEchange(
    correspondantDistantId: string,
    niveauSecurite: NiveauSecurite,
    numerosSeriesDistants: {
      signatureNumeroSerie?: string;
      chiffrementNumeroSerie?: string;
    }
  ): Promise<CertificatsValidesEchange> {
    if (niveauSecurite === 'NON_SECURISE') {
      return {};
    }

    const resultat: CertificatsValidesEchange = {};

    if (niveauSecurite === 'SIGNE' || niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      const bicleSign = this.resoudreBicleLocale('SIGNATURE');
      await this.validerCertificatEn4Etapes(
        bicleSign.certificat.numeroSerie,
        'SIGNATURE',
        this.correspondantId
      );
      resultat.propreSignature = bicleSign;

      resultat.distantSignature = await this.resoudreEtValiderCertificatDistant(
        correspondantDistantId,
        'SIGNATURE',
        numerosSeriesDistants.signatureNumeroSerie
      );
    }

    if (niveauSecurite === 'CHIFFRE' || niveauSecurite === 'SIGNE_ET_CHIFFRE') {
      const bicleChiff = this.resoudreBicleLocale('CHIFFREMENT');
      await this.validerCertificatEn4Etapes(
        bicleChiff.certificat.numeroSerie,
        'CHIFFREMENT',
        this.correspondantId
      );
      resultat.propreChiffrement = bicleChiff;

      resultat.distantChiffrement = await this.resoudreEtValiderCertificatDistant(
        correspondantDistantId,
        'CHIFFREMENT',
        numerosSeriesDistants.chiffrementNumeroSerie
      );
    }

    return resultat;
  }

  private construirePayloadSortant(params: {
    echangeId: string;
    numeroSequence: number;
    typeMessage: TypeMessageChat;
    niveauSecurite: NiveauSecurite;
    correspondantRecepteurId: string;
    horodatage: string;
    contenu: string;
    certs: CertificatsValidesEchange;
  }): MessageChatPayload {
    const base: MessageChatPayload = {
      echangeId: params.echangeId,
      numeroSequence: params.numeroSequence,
      typeMessage: params.typeMessage,
      niveauSecurite: params.niveauSecurite,
      emetteurId: this.correspondantId,
      correspondantRecepteurId: params.correspondantRecepteurId,
      horodatage: params.horodatage
    };

    if (params.niveauSecurite === 'NON_SECURISE') {
      return {
        ...base,
        contenu: params.contenu
      };
    }

    const donneesSignees = construireDonneesSignees({
      echangeId: params.echangeId,
      numeroSequence: params.numeroSequence,
      typeMessage: params.typeMessage,
      niveauSecurite: params.niveauSecurite,
      emetteurId: this.correspondantId,
      correspondantRecepteurId: params.correspondantRecepteurId,
      horodatage: params.horodatage,
      contenu: params.contenu
    });

    if (params.niveauSecurite === 'SIGNE') {
      const bicleSign = params.certs.propreSignature!;
      const signature = signMessageText(donneesSignees, bicleSign.clePrivee);
      return {
        ...base,
        contenu: params.contenu,
        signature,
        numeroSerieCertificatSignature: bicleSign.certificat.numeroSerie
      };
    }

    if (params.niveauSecurite === 'CHIFFRE') {
      const certDest = params.certs.distantChiffrement!;
      const contenuChiffre = encryptHybridMessage(
        params.contenu,
        certDest.clePublique
      );
      return {
        ...base,
        contenuChiffre,
        numeroSerieCertificatChiffrement: certDest.numeroSerie
      };
    }

    // SIGNE_ET_CHIFFRE : signer le texte en clair d'abord, puis chiffrer
    const bicleSign = params.certs.propreSignature!;
    const certDest = params.certs.distantChiffrement!;
    const signature = signMessageText(donneesSignees, bicleSign.clePrivee);
    const chargeInterne: ChargeSigneeEtChiffree = {
      contenu: params.contenu,
      signature,
      numeroSerieCertificatSignature: bicleSign.certificat.numeroSerie
    };
    const contenuChiffre = encryptHybridMessage(
      JSON.stringify(chargeInterne),
      certDest.clePublique
    );

    return {
      ...base,
      contenuChiffre,
      numeroSerieCertificatChiffrement: certDest.numeroSerie
    };
  }

  private async dechiffrerEtVerifierPayloadEntrant(
    payload: MessageChatPayload,
    certs: CertificatsValidesEchange,
    sessionVerrouillee: boolean
  ): Promise<{
    contenu: string;
    numeroSerieCertificatSignature?: string;
  }> {
    if (payload.niveauSecurite === 'NON_SECURISE') {
      if (typeof payload.contenu !== 'string') {
        throw new ErreurSecuriteEchange(
          'CONTENU_MANQUANT',
          'Le champ contenu est obligatoire en mode NON_SECURISE.'
        );
      }
      return { contenu: payload.contenu };
    }

    if (payload.niveauSecurite === 'SIGNE') {
      if (typeof payload.contenu !== 'string' || typeof payload.signature !== 'string') {
        throw new ErreurSecuriteEchange(
          'SIGNATURE_OU_CONTENU_MANQUANT',
          'Un message SIGNE doit contenir le texte et sa signature RSA-SHA256.'
        );
      }
      const certSign = certs.distantSignature!;
      if (
        payload.numeroSerieCertificatSignature &&
        payload.numeroSerieCertificatSignature !== certSign.numeroSerie
      ) {
        throw new ErreurSecuriteEchange(
          'CERTIFICAT_SIGNATURE_INCOHERENT',
          `Numéro de série de certificat signataire incohérent (${payload.numeroSerieCertificatSignature} vs ${certSign.numeroSerie}).`
        );
      }

      const donneesSignees = construireDonneesSignees({
        echangeId: payload.echangeId,
        numeroSequence: payload.numeroSequence,
        typeMessage: payload.typeMessage,
        niveauSecurite: payload.niveauSecurite,
        emetteurId: payload.emetteurId,
        correspondantRecepteurId: payload.correspondantRecepteurId,
        horodatage: payload.horodatage,
        contenu: payload.contenu
      });

      const ok = verifyMessageSignature(
        donneesSignees,
        payload.signature,
        certSign.clePublique
      );
      if (!ok) {
        throw new ErreurSecuriteEchange(
          'SIGNATURE_MESSAGE_INVALIDE',
          `Signature RSA-SHA256 invalide sur le message #${payload.numeroSequence} de "${payload.emetteurId}".`
        );
      }

      return {
        contenu: payload.contenu,
        numeroSerieCertificatSignature: certSign.numeroSerie
      };
    }

    if (typeof payload.contenuChiffre !== 'string') {
      throw new ErreurSecuriteEchange(
        'CONTENU_CHIFFRE_MANQUANT',
        `Un message ${payload.niveauSecurite} doit transporter une charge utile chiffrée.`
      );
    }

    const bicleChiff = certs.propreChiffrement!;
    if (
      payload.numeroSerieCertificatChiffrement &&
      payload.numeroSerieCertificatChiffrement !== bicleChiff.certificat.numeroSerie
    ) {
      throw new ErreurSecuriteEchange(
        'CERTIFICAT_CHIFFREMENT_INCOHERENT',
        `Le message cible le certificat "${payload.numeroSerieCertificatChiffrement}" au lieu de "${bicleChiff.certificat.numeroSerie}".`
      );
    }

    let texteDechiffre: string;
    try {
      texteDechiffre = decryptHybridMessage(
        payload.contenuChiffre,
        bicleChiff.clePrivee
      );
    } catch {
      throw new ErreurSecuriteEchange(
        'DECHIFFREMENT_IMPOSSIBLE',
        `Échec du déchiffrement hybride (RSA-OAEP + AES-256-GCM) du message #${payload.numeroSequence}.`
      );
    }

    if (payload.niveauSecurite === 'CHIFFRE') {
      return { contenu: texteDechiffre };
    }

    // SIGNE_ET_CHIFFRE : vérifier la signature après déchiffrement
    let chargeInterne: Partial<ChargeSigneeEtChiffree>;
    try {
      chargeInterne = JSON.parse(texteDechiffre) as Partial<ChargeSigneeEtChiffree>;
    } catch {
      throw new ErreurSecuriteEchange(
        'FORMAT_DECHIFFRE_INVALIDE',
        'Charge utile interne invalide après déchiffrement en mode SIGNE_ET_CHIFFRE.'
      );
    }

    if (
      typeof chargeInterne.contenu !== 'string' ||
      typeof chargeInterne.signature !== 'string'
    ) {
      throw new ErreurSecuriteEchange(
        'SIGNATURE_INTERNE_MANQUANTE',
        'Signature ou contenu manquant après déchiffrement en mode SIGNE_ET_CHIFFRE.'
      );
    }

    let certSign = certs.distantSignature!;
    if (
      chargeInterne.numeroSerieCertificatSignature &&
      chargeInterne.numeroSerieCertificatSignature !== certSign.numeroSerie
    ) {
      if (sessionVerrouillee) {
        throw new ErreurSecuriteEchange(
          'CERTIFICAT_SIGNATURE_INCOHERENT',
          `Certificat signataire interne incohérent (${chargeInterne.numeroSerieCertificatSignature} vs ${certSign.numeroSerie}).`
        );
      }
      certSign = await this.validerCertificatEn4Etapes(
        chargeInterne.numeroSerieCertificatSignature,
        'SIGNATURE',
        payload.emetteurId
      );
      certs.distantSignature = certSign;
    }

    const donneesSignees = construireDonneesSignees({
      echangeId: payload.echangeId,
      numeroSequence: payload.numeroSequence,
      typeMessage: payload.typeMessage,
      niveauSecurite: payload.niveauSecurite,
      emetteurId: payload.emetteurId,
      correspondantRecepteurId: payload.correspondantRecepteurId,
      horodatage: payload.horodatage,
      contenu: chargeInterne.contenu
    });

    const ok = verifyMessageSignature(
      donneesSignees,
      chargeInterne.signature,
      certSign.clePublique
    );
    if (!ok) {
      throw new ErreurSecuriteEchange(
        'SIGNATURE_MESSAGE_INVALIDE',
        `Signature RSA-SHA256 invalide après déchiffrement du message #${payload.numeroSequence} de "${payload.emetteurId}".`
      );
    }

    return {
      contenu: chargeInterne.contenu,
      numeroSerieCertificatSignature: certSign.numeroSerie
    };
  }

  private async publierPayload(
    correspondantRecepteurId: string,
    payload: MessageChatPayload
  ): Promise<void> {
    await this.transport.publierMessageChat(correspondantRecepteurId, payload, {
      content_type: 'application/json',
      delivery_mode: 2,
      correlation_id: payload.echangeId,
      type: payload.typeMessage,
      timestamp: payload.horodatage,
      headers: {
        echange_id: payload.echangeId,
        type_message: payload.typeMessage,
        niveau_securite: payload.niveauSecurite,
        emetteur_id: payload.emetteurId,
        correspondant_recepteur_id: payload.correspondantRecepteurId,
        numero_sequence: payload.numeroSequence
      }
    });
  }

  private async validerEtDecoderEnveloppe(
    enveloppe: EnveloppeChatAmqp
  ): Promise<MessageRecu> {
    const { payload, properties } = enveloppe;
    if (!payload || typeof payload !== 'object') {
      throw new ErreurSecuriteEchange(
        'PAYLOAD_INVALIDE',
        'Charge utile de messagerie invalide.'
      );
    }

    if (payload.correspondantRecepteurId !== this.correspondantId) {
      throw new ErreurSecuriteEchange(
        'CORRESPONDANT_RECEPTEUR_INCOHERENT',
        `Message destiné à "${payload.correspondantRecepteurId}" reçu par "${this.correspondantId}".`
      );
    }

    if (
      properties.correlation_id !== payload.echangeId ||
      properties.type !== payload.typeMessage ||
      properties.headers?.echange_id !== payload.echangeId ||
      properties.headers?.type_message !== payload.typeMessage ||
      properties.headers?.niveau_securite !== payload.niveauSecurite ||
      properties.headers?.emetteur_id !== payload.emetteurId
    ) {
      throw new ErreurSecuriteEchange(
        'EN_TETES_AMQP_INCOHERENTS',
        'Incohérence détectée entre les propriétés AMQP et le contenu du message.'
      );
    }

    if (
      !Number.isInteger(payload.numeroSequence) ||
      payload.numeroSequence < 1
    ) {
      throw new ErreurSequenceMessage(
        'SEQUENCE_INVALIDE',
        `Numéro de séquence invalide (${String(payload.numeroSequence)}).`
      );
    }

    const existante = this.sessions.get(payload.echangeId);

    if (!existante) {
      if (payload.typeMessage !== 'INIT_ECHANGE') {
        throw new ErreurSessionFermee(
          'SESSION_INCONNUE',
          `Message "${payload.typeMessage}" reçu pour un Échange inconnu "${payload.echangeId}".`
        );
      }
      if (payload.numeroSequence !== 1) {
        throw new ErreurSequenceMessage(
          'SEQUENCE_INITIALE_INVALIDE',
          `Un message INIT_ECHANGE doit porter le numéro de séquence 1 (reçu : ${payload.numeroSequence}).`
        );
      }

      const certs = await this.validerCertificatsPourEchange(
        payload.emetteurId,
        payload.niveauSecurite,
        {
          signatureNumeroSerie: payload.numeroSerieCertificatSignature
        }
      );

      const { contenu: texteClair } = await this.dechiffrerEtVerifierPayloadEntrant(
        payload,
        certs,
        false
      );

      const estCloture = verifierCoherenceFinMsg(payload.typeMessage, texteClair);
      const nouvelleSession: SessionEchangeState = {
        echangeId: payload.echangeId,
        correspondantDistantId: payload.emetteurId,
        niveauSecurite: payload.niveauSecurite,
        statut: estCloture ? 'FERMEE' : 'ACTIVE',
        initiateurId: payload.emetteurId,
        dernierNumeroSequenceEnvoye: 0,
        dernierNumeroSequenceRecu: payload.numeroSequence,
        sequencesRecuesParEmetteur: {
          [payload.emetteurId]: payload.numeroSequence
        },
        ...(certs.distantSignature
          ? { certificatDistantSignatureNumeroSerie: certs.distantSignature.numeroSerie }
          : {}),
        ...(certs.distantChiffrement
          ? { certificatDistantChiffrementNumeroSerie: certs.distantChiffrement.numeroSerie }
          : {}),
        horodatageOuverture: payload.horodatage,
        ...(estCloture ? { horodatageCloture: payload.horodatage } : {})
      };
      this.sessions.set(payload.echangeId, nouvelleSession);

      return {
        echangeId: payload.echangeId,
        numeroSequence: payload.numeroSequence,
        typeMessage: payload.typeMessage,
        niveauSecurite: payload.niveauSecurite,
        emetteurId: payload.emetteurId,
        correspondantRecepteurId: payload.correspondantRecepteurId,
        contenu: texteClair,
        horodatage: payload.horodatage,
        sessionFermee: estCloture
      };
    }

    if (existante.statut === 'FERMEE') {
      throw new ErreurSessionFermee(
        'SESSION_FERMEE',
        `L'Échange "${payload.echangeId}" est clos et rejette tout nouveau message.`
      );
    }

    if (payload.typeMessage === 'INIT_ECHANGE') {
      throw new ErreurSequenceMessage(
        'INIT_ECHANGE_DUPLIQUE',
        `Un message INIT_ECHANGE a été reçu sur l'Échange déjà actif "${payload.echangeId}".`
      );
    }

    if (payload.emetteurId !== existante.correspondantDistantId) {
      throw new ErreurSecuriteEchange(
        'EMETTEUR_INATTENDU',
        `Émetteur "${payload.emetteurId}" non autorisé sur l'Échange "${payload.echangeId}".`
      );
    }

    if (payload.niveauSecurite !== existante.niveauSecurite) {
      throw new ErreurSecuriteEchange(
        'NIVEAU_SECURITE_IMMUABLE',
        `Tentative de modification du Niveau de sécurité de "${existante.niveauSecurite}" vers "${payload.niveauSecurite}" sur l'Échange "${payload.echangeId}".`
      );
    }

    const dernierSeqEmetteur =
      existante.sequencesRecuesParEmetteur[payload.emetteurId] ?? 0;
    if (payload.numeroSequence <= dernierSeqEmetteur) {
      throw new ErreurSequenceMessage(
        'SEQUENCE_NON_MONOTONE',
        `Numéro de séquence non monotone (${payload.numeroSequence} <= ${dernierSeqEmetteur}) pour "${payload.emetteurId}" sur "${payload.echangeId}".`
      );
    }

    const certs = await this.validerCertificatsPourEchange(
      existante.correspondantDistantId,
      existante.niveauSecurite,
      {
        signatureNumeroSerie: existante.certificatDistantSignatureNumeroSerie,
        chiffrementNumeroSerie: existante.certificatDistantChiffrementNumeroSerie
      }
    );

    const { contenu: texteClair } = await this.dechiffrerEtVerifierPayloadEntrant(
      payload,
      certs,
      true
    );
    const estCloture = verifierCoherenceFinMsg(payload.typeMessage, texteClair);

    existante.sequencesRecuesParEmetteur[payload.emetteurId] = payload.numeroSequence;
    existante.dernierNumeroSequenceRecu = payload.numeroSequence;
    if (estCloture) {
      existante.statut = 'FERMEE';
      existante.horodatageCloture = payload.horodatage;
    }

    return {
      echangeId: payload.echangeId,
      numeroSequence: payload.numeroSequence,
      typeMessage: payload.typeMessage,
      niveauSecurite: existante.niveauSecurite,
      emetteurId: payload.emetteurId,
      correspondantRecepteurId: payload.correspondantRecepteurId,
      contenu: texteClair,
      horodatage: payload.horodatage,
      sessionFermee: estCloture
    };
  }
}
