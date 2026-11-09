import {
  generateRsaKeyPair,
  signCertificat,
  type RsaKeyPair,
} from '../crypto/index.js';
import { InMemoryJmsBroker, type JmsTextMessage } from '../broker/index.js';

import type {
  Certificat,
  AutoriteCertificationInfo,
  UsageCle,
} from '../types/index.js';

export interface CreateRootOptions {
  id: string;
  nomOrganisationnel: string;
  broker: InMemoryJmsBroker;
  keyPair?: RsaKeyPair;
  numeroSerie?: string;
  dateDebutValidite?: string;
  dateFinValidite?: string;
}

export interface CreerAcFilleOptions {
  id: string;
  nomOrganisationnel: string;
  keyPair?: RsaKeyPair;
  numeroSerie?: string;
  dateDebutValidite?: string;
  dateFinValidite?: string;
}

export interface SignerCertificatOptions {
  numeroSerie: string;
  sujet: string;
  clePublique: string;
  usage: UsageCle;
  natureRessource?: string;
  dateDebutValidite?: string;
  dateFinValidite?: string;
}

export interface HierarchieAcResult {
  acRacine: AutoriteCertification;
  acsNiveau2: AutoriteCertification[];
  acsNiveau3: AutoriteCertification[];
  allAcs: AutoriteCertification[];
}

export class AutoriteCertification {
  public readonly id: string;
  public readonly nomOrganisationnel: string;
  public readonly niveau: number;
  public readonly acParenteId: string | null;
  public readonly keyPair: RsaKeyPair;
  public readonly certificat: Certificat;
  public readonly broker: InMemoryJmsBroker;
  public readonly certificatsValides = new Map<string, Certificat>();
  private compteurSerie = 1;

  constructor(params: {
    id: string;
    nomOrganisationnel: string;
    niveau: number;
    acParenteId: string | null;
    keyPair: RsaKeyPair;
    certificat: Certificat;
    broker: InMemoryJmsBroker;
  }) {
    this.id = params.id;
    this.nomOrganisationnel = params.nomOrganisationnel;
    this.niveau = params.niveau;
    this.acParenteId = params.acParenteId;
    this.keyPair = params.keyPair;
    this.certificat = params.certificat;
    this.broker = params.broker;

    this.certificatsValides.set(this.certificat.numeroSerie, this.certificat);
    this.demarrerEcouteJms();
  }

  public genererNumeroSerie(): string {
    const cleanId = this.id.replace(/^AC-N\d+-/, '');
    const num = String(this.compteurSerie++).padStart(6, '0');
    return `SN-2026-${cleanId}-${num}`;
  }

  public demarrerEcouteJms(): void {
    this.broker.registerQueueConsumer(
      `queue.pki.ac.${this.id}.demandes`,
      (message) => this.traiterDemandeQueue(message)
    );
  }

  public traiterDemandeQueue(message: JmsTextMessage): void {
    const correlationId =
      (message.headers.JMSCorrelationID as string) ||
      (message.payload as any)?.demandeId;
    const replyTo = message.headers.JMSReplyTo as string | undefined;
    const typeMessage = message.headers.type_message as string;

    if (typeMessage === 'DEMANDE_CERTIFICATION') {
      const payload = message.payload as any;
      const genererBicle = !!payload.genererBicle;
      let clePublique = payload.clePublique;
      let clePriveeGeneree: string | null = null;

      if (genererBicle) {
        const generatedKeyPair = generateRsaKeyPair();
        clePublique = generatedKeyPair.publicKeyBase64;
        clePriveeGeneree = generatedKeyPair.privateKeyPem;
        // The private key is purely ephemeral: never stored in the AC instance
      }

      const numeroSerie = this.genererNumeroSerie();
      const cert = this.signerCertificat({
        numeroSerie,
        sujet: payload.sujet,
        clePublique,
        usage: payload.usageAutorise ?? payload.usage,
        natureRessource: payload.natureRessource,
      });

      if (replyTo) {
        this.broker.sendToQueue(replyTo, {
          headers: {
            JMSCorrelationID: correlationId,
            type_message: 'REPONSE_CERTIFICATION',
            statut_traitement: 'SUCCES',
            ac_emettrice_id: this.id,
          },
          payload: {
            demandeId: correlationId,
            statut: 'SUCCES',
            certificat: cert,
            clePriveeGeneree,
          },
        });
      }
    }
  }


  public getInfo(): AutoriteCertificationInfo {
    return {
      acId: this.id,
      nomOrganisationnel: this.nomOrganisationnel,
      niveau: this.niveau,
      acParenteId: this.acParenteId,
      certificatAc: this.certificat,
    };
  }

  public publierCertificat(cert: Certificat): void {
    this.broker.publish('topic.pki.publications.certificats', {
      headers: {
        type_message: 'PUBLICATION_CERTIFICAT',
        ac_emettrice_id: cert.identifiantAcEmettrice,
        niveau_ac: cert.niveauAcEmettrice ?? this.niveau,
        nature_ressource: cert.natureRessource ?? 'autorite_certification',
        numero_serie: cert.numeroSerie,
      },
      payload: cert,
    });
  }

  public signerCertificat(options: SignerCertificatOptions): Certificat {
    const now = new Date();
    const oneYearLater = new Date(now.getTime() + 365 * 24 * 60 * 60 * 1000);

    const certData: Omit<Certificat, 'signatureAc'> = {
      numeroSerie: options.numeroSerie,
      identifiantAcEmettrice: this.id,
      niveauAcEmettrice: this.niveau,
      dateDebutValidite: options.dateDebutValidite ?? now.toISOString(),
      dateFinValidite: options.dateFinValidite ?? oneYearLater.toISOString(),
      usage: options.usage,
      sujet: options.sujet,
      natureRessource: options.natureRessource,
      clePublique: options.clePublique,
      algorithmeSignature: 'SHA256withRSA',
    };

    const signedCert = signCertificat(certData, this.keyPair.privateKeyPem);
    this.certificatsValides.set(signedCert.numeroSerie, signedCert);
    this.publierCertificat(signedCert);
    return signedCert;

  }

  public creerAcFille(options: CreerAcFilleOptions): AutoriteCertification {
    const childKeyPair = options.keyPair ?? generateRsaKeyPair();
    const childNiveau = this.niveau + 1;
    const now = new Date();
    const fiveYearsLater = new Date(now.getTime() + 5 * 365 * 24 * 60 * 60 * 1000);

    const certData: Omit<Certificat, 'signatureAc'> = {
      numeroSerie: options.numeroSerie ?? `SN-AC-N${childNiveau}-${options.id}`,
      identifiantAcEmettrice: this.id,
      niveauAcEmettrice: this.niveau,
      dateDebutValidite: options.dateDebutValidite ?? now.toISOString(),
      dateFinValidite: options.dateFinValidite ?? fiveYearsLater.toISOString(),
      usage: 'CERTIFICATION_AC',
      sujet: options.id,
      natureRessource: 'autorite_certification',
      clePublique: childKeyPair.publicKeyBase64,
      algorithmeSignature: 'SHA256withRSA',
    };

    const signedCert = signCertificat(certData, this.keyPair.privateKeyPem);
    this.publierCertificat(signedCert);

    return new AutoriteCertification({
      id: options.id,
      nomOrganisationnel: options.nomOrganisationnel,
      niveau: childNiveau,
      acParenteId: this.id,
      keyPair: childKeyPair,
      certificat: signedCert,
      broker: this.broker,
    });
  }

  public static createRoot(options: CreateRootOptions): AutoriteCertification {
    const rootKeyPair = options.keyPair ?? generateRsaKeyPair();
    const now = new Date();
    const tenYearsLater = new Date(now.getTime() + 10 * 365 * 24 * 60 * 60 * 1000);

    const certData: Omit<Certificat, 'signatureAc'> = {
      numeroSerie: options.numeroSerie ?? `SN-AC-N1-ROOT`,
      identifiantAcEmettrice: options.id,
      niveauAcEmettrice: 1,
      dateDebutValidite: options.dateDebutValidite ?? now.toISOString(),
      dateFinValidite: options.dateFinValidite ?? tenYearsLater.toISOString(),
      usage: 'CERTIFICATION_AC',
      sujet: options.id,
      natureRessource: 'autorite_certification',
      clePublique: rootKeyPair.publicKeyBase64,
      algorithmeSignature: 'SHA256withRSA',
    };

    const selfSignedCert = signCertificat(certData, rootKeyPair.privateKeyPem);

    const rootAc = new AutoriteCertification({
      id: options.id,
      nomOrganisationnel: options.nomOrganisationnel,
      niveau: 1,
      acParenteId: null,
      keyPair: rootKeyPair,
      certificat: selfSignedCert,
      broker: options.broker,
    });

    rootAc.publierCertificat(selfSignedCert);
    return rootAc;
  }
}

export function bootstrapHierarchieAc(broker: InMemoryJmsBroker): HierarchieAcResult {
  const acRacine = AutoriteCertification.createRoot({
    id: 'AC-N1-RACINE',
    nomOrganisationnel: 'Direction Générale — Autorité Racine',
    broker,
  });

  const acN2Dsi = acRacine.creerAcFille({
    id: 'AC-N2-DSI',
    nomOrganisationnel: 'Direction des Systèmes d’Information',
  });

  const acN2Infra = acRacine.creerAcFille({
    id: 'AC-N2-INFRA',
    nomOrganisationnel: 'Direction des Infrastructures',
  });

  const acN3Msg = acN2Dsi.creerAcFille({
    id: 'AC-N3-DSI-MESSAGERIE',
    nomOrganisationnel: 'Direction des Systèmes d’Information — Service Messagerie',
  });

  const acN3Etudes = acN2Dsi.creerAcFille({
    id: 'AC-N3-DSI-ETUDES',
    nomOrganisationnel: 'Direction des Systèmes d’Information — Service Études et Développement',
  });

  const acN3Reseau = acN2Infra.creerAcFille({
    id: 'AC-N3-INFRA-RESEAU',
    nomOrganisationnel: 'Direction des Infrastructures — Service Réseau et Télécoms',
  });

  const acsNiveau2 = [acN2Dsi, acN2Infra];
  const acsNiveau3 = [acN3Msg, acN3Etudes, acN3Reseau];
  const allAcs = [acRacine, ...acsNiveau2, ...acsNiveau3];

  return {
    acRacine,
    acsNiveau2,
    acsNiveau3,
    allAcs,
  };
}
