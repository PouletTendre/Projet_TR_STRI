import { AMQP_EXCHANGES, InMemoryAmqpBroker } from '../amqp/index.js';
import {
  generateRsaKeyPair,
  signCertificat,
  signLcr,
  type RsaKeyPair
} from '../crypto/index.js';
import type {
  AutoriteCertificationInfo,
  Certificat,
  EntreeLcr,
  ListeCertificatsRevoques,
  PublicationCertificatPayload,
  PublicationLcrPayload
} from '../types/index.js';

export interface OptionsValiditeAc {
  dateDebut?: Date;
  dureeValiditeJours?: number;
}

export interface HierarchieAc {
  generateurNumeroSerie: GenerateurNumeroSerie;
  racine: AutoriteCertification;
  directions: {
    dsi: AutoriteCertification;
    infra: AutoriteCertification;
  };
  services: {
    dsiMessagerie: AutoriteCertification;
    infraReseau: AutoriteCertification;
  };
  autorites: Map<string, AutoriteCertification>;
}

/**
 * Générateur garantissant l'unicité des numéros de série des Certificats
 * au sein de l'unique Domaine de confiance.
 */
export class GenerateurNumeroSerie {
  private compteur = 0;
  private readonly emis = new Set<string>();

  generer(segmentOrganisation: string, annee = new Date().getUTCFullYear()): string {
    const cleanSegment = segmentOrganisation
      .replace(/^AC-/i, '')
      .replace(/[^A-Za-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .toUpperCase();

    let candidat: string;
    do {
      this.compteur += 1;
      const suffixe = String(this.compteur).padStart(6, '0');
      candidat = `SN-${annee}-${cleanSegment}-${suffixe}`;
    } while (this.emis.has(candidat));

    this.emis.add(candidat);
    return candidat;
  }

  estDejaAttribue(numeroSerie: string): boolean {
    return this.emis.has(numeroSerie);
  }
}

export interface AutoriteCertificationConfig {
  acId: string;
  nomOrganisationnel: string;
  niveau: number;
  acParenteId: string | null;
  broker: InMemoryAmqpBroker;
  generateurNumeroSerie: GenerateurNumeroSerie;
  keyPair?: RsaKeyPair;
}

/**
 * Autorité de Certification (AC) d'un niveau hiérarchique donné (1 = Racine, 2 = Direction, 3 = Service).
 * N'expose aucune interface HTTP directe ; communique uniquement via AMQP 0-9-1.
 */
export class AutoriteCertification {
  readonly acId: string;
  readonly nomOrganisationnel: string;
  readonly niveau: number;
  readonly acParenteId: string | null;

  private readonly broker: InMemoryAmqpBroker;
  private readonly generateurNumeroSerie: GenerateurNumeroSerie;
  private readonly keyPair: RsaKeyPair;
  private certificatAc: Certificat | null = null;
  private readonly certificatsEmis = new Map<string, Certificat>();
  private numeroVersionLcr = 0;
  private readonly entreesLcr = new Map<string, EntreeLcr>();
  private lcrCourante: ListeCertificatsRevoques;

  constructor(config: AutoriteCertificationConfig) {
    this.acId = config.acId;
    this.nomOrganisationnel = config.nomOrganisationnel;
    this.niveau = config.niveau;
    this.acParenteId = config.acParenteId;
    this.broker = config.broker;
    this.generateurNumeroSerie = config.generateurNumeroSerie;
    this.keyPair = config.keyPair ?? generateRsaKeyPair();
    this.lcrCourante = this.construireEtSignerLcr(new Date());
  }

  get clePubliqueBase64(): string {
    return this.keyPair.publicKeyBase64;
  }

  getCertificatAc(): Certificat {
    if (!this.certificatAc) {
      throw new Error(`Le certificat de l'AC "${this.acId}" n'a pas encore été émis.`);
    }
    return { ...this.certificatAc };
  }

  getInfo(): AutoriteCertificationInfo {
    return {
      acId: this.acId,
      nomOrganisationnel: this.nomOrganisationnel,
      niveau: this.niveau,
      acParenteId: this.acParenteId,
      certificatAc: this.getCertificatAc()
    };
  }

  getLcrCourante(): ListeCertificatsRevoques {
    return {
      ...this.lcrCourante,
      entrees: this.lcrCourante.entrees.map((e) => ({ ...e }))
    };
  }

  /**
   * Auto-signe le certificat de l'AC Racine (niveau 1) et le publie sur ex.pki.publications.
   */
  async autoSignerRacine(options: OptionsValiditeAc = {}): Promise<Certificat> {
    if (this.niveau !== 1 || this.acParenteId !== null) {
      throw new Error(`Seule l'AC Racine de niveau 1 peut être auto-signée (${this.acId}).`);
    }

    const cert = this.signerCertificatAc(this.acId, this.keyPair.publicKeyBase64, options);
    this.certificatAc = cert;
    this.certificatsEmis.set(cert.numeroSerie, cert);

    await this.publierCertificat(cert, this.getInfo());
    return cert;
  }

  /**
   * Émet et signe le certificat d'une AC Fille (niveau 2 ou 3) et le publie sur ex.pki.publications.
   */
  async certifierAcFille(
    acFille: AutoriteCertification,
    options: OptionsValiditeAc = {}
  ): Promise<Certificat> {
    if (acFille.acParenteId !== this.acId) {
      throw new Error(
        `Incohérence hiérarchique : "${acFille.acId}" a pour parente "${acFille.acParenteId}", pas "${this.acId}".`
      );
    }
    if (!this.certificatAc) {
      throw new Error(`L'AC parente "${this.acId}" doit être certifiée avant de signer "${acFille.acId}".`);
    }

    const cert = this.signerCertificatAc(acFille.acId, acFille.clePubliqueBase64, options);
    this.certificatsEmis.set(cert.numeroSerie, cert);
    acFille.definirCertificatAc(cert);

    await acFille.publierCertificat(cert, acFille.getInfo());
    return cert;
  }

  async publierLcr(): Promise<ListeCertificatsRevoques> {
    const lcr = this.getLcrCourante();
    const payload: PublicationLcrPayload = { lcr };
    await this.broker.publish(
      AMQP_EXCHANGES.PUBLICATIONS,
      `lcr.n${this.niveau}.${this.acId.toLowerCase()}`,
      payload,
      {
        type: 'PUBLICATION_LCR',
        headers: {
          acId: this.acId,
          niveau: this.niveau,
          numeroVersionLcr: lcr.numeroVersionLcr
        }
      }
    );
    return lcr;
  }

  protected definirCertificatAc(certificat: Certificat): void {
    this.certificatAc = certificat;
  }

  protected async publierCertificat(
    certificat: Certificat,
    autoriteInfo?: AutoriteCertificationInfo
  ): Promise<void> {
    const payload: PublicationCertificatPayload = {
      certificat,
      ...(autoriteInfo ? { autoriteInfo } : {})
    };
    const routingKey = autoriteInfo
      ? `certificat.n${this.niveau}.ac`
      : `certificat.n${this.niveau}.porteur`;

    await this.broker.publish(AMQP_EXCHANGES.PUBLICATIONS, routingKey, payload, {
      type: 'PUBLICATION_CERTIFICAT',
      headers: {
        acId: this.acId,
        niveau: this.niveau
      }
    });
  }

  private signerCertificatAc(
    sujetAcId: string,
    clePubliqueBase64: string,
    options: OptionsValiditeAc
  ): Certificat {
    const debut = options.dateDebut ?? new Date();
    const dureeJours = options.dureeValiditeJours ?? 3650;
    const fin = new Date(debut.getTime() + dureeJours * 24 * 60 * 60 * 1000);

    return signCertificat(
      {
        numeroSerie: this.generateurNumeroSerie.generer(sujetAcId, debut.getUTCFullYear()),
        identifiantAcEmettrice: this.acId,
        niveauAcEmettrice: this.niveau,
        dateDebutValidite: debut.toISOString(),
        dateFinValidite: fin.toISOString(),
        usage: 'CERTIFICATION_AC',
        sujet: sujetAcId,
        natureRessource: 'autorite_certification',
        clePublique: clePubliqueBase64,
        algorithmeSignature: 'SHA256withRSA'
      },
      this.keyPair.privateKeyPem
    );
  }

  private construireEtSignerLcr(dateEmission: Date): ListeCertificatsRevoques {
    this.numeroVersionLcr += 1;
    const prochaineMiseAJour = new Date(dateEmission.getTime() + 24 * 60 * 60 * 1000);
    return signLcr(
      {
        identifiantAc: this.acId,
        numeroVersionLcr: this.numeroVersionLcr,
        dateEmission: dateEmission.toISOString(),
        prochaineMiseAJour: prochaineMiseAJour.toISOString(),
        entrees: Array.from(this.entreesLcr.values())
      },
      this.keyPair.privateKeyPem
    );
  }
}

/**
 * Amorce la hiérarchie complète d'AC sur 3 niveaux dans le Domaine de confiance :
 * - Niveau 1 : AC-N1-RACINE (auto-signée)
 * - Niveau 2 : AC-N2-DSI, AC-N2-INFRA
 * - Niveau 3 : AC-N3-DSI-MESSAGERIE, AC-N3-INFRA-RESEAU
 */
export async function amorcerHierarchieAc(
  broker: InMemoryAmqpBroker,
  options: OptionsValiditeAc = {}
): Promise<HierarchieAc> {
  broker.declareExchange(AMQP_EXCHANGES.COMMANDES, 'direct', { durable: true });
  broker.declareExchange(AMQP_EXCHANGES.PUBLICATIONS, 'topic', { durable: true });

  const generateurNumeroSerie = new GenerateurNumeroSerie();

  const racine = new AutoriteCertification({
    acId: 'AC-N1-RACINE',
    nomOrganisationnel: 'AC Racine — Domaine de Confiance Organisationnel',
    niveau: 1,
    acParenteId: null,
    broker,
    generateurNumeroSerie
  });

  const dsi = new AutoriteCertification({
    acId: 'AC-N2-DSI',
    nomOrganisationnel: "Direction des Systèmes d'Information",
    niveau: 2,
    acParenteId: 'AC-N1-RACINE',
    broker,
    generateurNumeroSerie
  });

  const infra = new AutoriteCertification({
    acId: 'AC-N2-INFRA',
    nomOrganisationnel: 'Direction Infrastructure et Réseaux',
    niveau: 2,
    acParenteId: 'AC-N1-RACINE',
    broker,
    generateurNumeroSerie
  });

  const dsiMessagerie = new AutoriteCertification({
    acId: 'AC-N3-DSI-MESSAGERIE',
    nomOrganisationnel: "Direction des Systèmes d'Information — Service Messagerie",
    niveau: 3,
    acParenteId: 'AC-N2-DSI',
    broker,
    generateurNumeroSerie
  });

  const infraReseau = new AutoriteCertification({
    acId: 'AC-N3-INFRA-RESEAU',
    nomOrganisationnel: 'Direction Infrastructure et Réseaux — Service Réseau',
    niveau: 3,
    acParenteId: 'AC-N2-INFRA',
    broker,
    generateurNumeroSerie
  });

  await racine.autoSignerRacine(options);
  await racine.certifierAcFille(dsi, options);
  await racine.certifierAcFille(infra, options);
  await dsi.certifierAcFille(dsiMessagerie, options);
  await infra.certifierAcFille(infraReseau, options);

  // Publication initiale des LCR vides signées pour chaque AC
  await racine.publierLcr();
  await dsi.publierLcr();
  await infra.publierLcr();
  await dsiMessagerie.publierLcr();
  await infraReseau.publierLcr();

  const autorites = new Map<string, AutoriteCertification>([
    [racine.acId, racine],
    [dsi.acId, dsi],
    [infra.acId, infra],
    [dsiMessagerie.acId, dsiMessagerie],
    [infraReseau.acId, infraReseau]
  ]);

  return {
    generateurNumeroSerie,
    racine,
    directions: { dsi, infra },
    services: { dsiMessagerie, infraReseau },
    autorites
  };
}
