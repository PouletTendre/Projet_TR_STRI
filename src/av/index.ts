import { InMemoryJmsBroker, type JmsTextMessage } from '../broker/index.js';
import { ServicePublication } from '../annuaire/index.js';
import { verifyCertificatSignature } from '../crypto/index.js';
import type {
  Certificat,
  NatureRessource,
  StatutCertificat,
  StatutCertificatReponse,
  ValidationCertificatRequete,
  ValidationCertificatReponse,
  PublicationLcrPayload,
  RestRequest,
  RestResponse,
  ErreurApi,
} from '../types/index.js';

interface StatutLocalEntree {
  numeroSerie: string;
  statut: StatutCertificat;
  identifiantAcEmettrice?: string;
  motifInvalidation?: string | null;
  dateInvalidation?: string | null;
}

export interface AutoriteValidationOptions {
  id: string;
  nature: NatureRessource;
  broker: InMemoryJmsBroker;
  annuaire: ServicePublication;
}

export class AutoriteValidation {
  public readonly id: string;
  public readonly nature: NatureRessource;
  public readonly broker: InMemoryJmsBroker;
  public readonly annuaire: ServicePublication;

  private statutsCertificats = new Map<string, StatutLocalEntree>();
  private unsubscribeCertificats: () => void;
  private unsubscribeLcr: () => void;

  constructor(options: AutoriteValidationOptions) {
    this.id = options.id;
    this.nature = options.nature;
    this.broker = options.broker;
    this.annuaire = options.annuaire;

    // Real-time subscription to published certificates
    this.unsubscribeCertificats = this.broker.subscribe<Certificat>(
      'topic.pki.publications.certificats',
      (msg) => this.onCertificatPublie(msg)
    );

    // Real-time subscription to LCR updates
    this.unsubscribeLcr = this.broker.subscribe<PublicationLcrPayload>(
      'topic.pki.publications.lcr',
      (msg) => this.onLcrPublie(msg)
    );
  }

  public destroy(): void {
    if (this.unsubscribeCertificats) {
      this.unsubscribeCertificats();
    }
    if (this.unsubscribeLcr) {
      this.unsubscribeLcr();
    }
  }

  public enregistrerCertificat(cert: Certificat): void {
    if (!cert || !cert.numeroSerie) {
      return;
    }
    const existing = this.statutsCertificats.get(cert.numeroSerie);
    if (!existing || existing.statut !== 'REVOQUE') {
      this.statutsCertificats.set(cert.numeroSerie, {
        numeroSerie: cert.numeroSerie,
        statut: existing?.statut ?? 'VALIDE',
        identifiantAcEmettrice: cert.identifiantAcEmettrice,
        motifInvalidation: existing?.motifInvalidation ?? null,
        dateInvalidation: existing?.dateInvalidation ?? null,
      });
    }
  }

  public onCertificatPublie(message: JmsTextMessage<Certificat>): void {
    this.enregistrerCertificat(message.payload);
  }

  public onLcrPublie(message: JmsTextMessage<PublicationLcrPayload>): void {
    const payload = message.payload;
    if (payload?.evenementDeclencheur) {
      const ev = payload.evenementDeclencheur;
      this.mettreAJourStatut(
        ev.numeroSerieCertificat,
        ev.nouveauStatut,
        ev.motif,
        ev.dateEffet
      );
    }

    if (payload?.entreesActives && Array.isArray(payload.entreesActives)) {
      for (const entree of payload.entreesActives) {
        this.mettreAJourStatut(
          entree.numeroSerieCertificat,
          entree.statut,
          entree.motif,
          entree.dateInvalidation
        );
      }
    }

    const headerSerie = message.headers?.numero_serie_affecte as
      | string
      | undefined;
    const headerStatut = message.headers?.nouveau_statut as
      | StatutCertificat
      | undefined;
    if (headerSerie && headerStatut) {
      this.mettreAJourStatut(headerSerie, headerStatut);
    }
  }

  public mettreAJourStatut(
    numeroSerie: string,
    statut: StatutCertificat,
    motif?: string | null,
    dateInvalidation?: string | null
  ): void {
    const existing = this.statutsCertificats.get(numeroSerie);
    const cert = this.annuaire.getCertificatParNumeroSerie(numeroSerie);

    this.statutsCertificats.set(numeroSerie, {
      numeroSerie,
      statut,
      identifiantAcEmettrice:
        existing?.identifiantAcEmettrice ?? cert?.identifiantAcEmettrice,
      motifInvalidation:
        statut === 'VALIDE' ? null : motif ?? existing?.motifInvalidation ?? null,
      dateInvalidation:
        statut === 'VALIDE'
          ? null
          : dateInvalidation ??
            existing?.dateInvalidation ??
            new Date().toISOString(),
    });
  }

  public obtenirStatut(numeroSerie: string): StatutCertificatReponse {
    const now = new Date().toISOString();
    let entry = this.statutsCertificats.get(numeroSerie);

    if (!entry) {
      const cert = this.annuaire.getCertificatParNumeroSerie(numeroSerie);
      if (cert) {
        entry = {
          numeroSerie,
          statut: 'VALIDE',
          identifiantAcEmettrice: cert.identifiantAcEmettrice,
          motifInvalidation: null,
          dateInvalidation: null,
        };
        this.statutsCertificats.set(numeroSerie, entry);
      }
    }

    if (!entry) {
      return {
        numeroSerie,
        statut: 'INCONNU',
        identifiantAcEmettrice: undefined,
        motifInvalidation: null,
        dateInvalidation: null,
        horodatageVerification: now,
        identifiantAv: this.id,
      };
    }

    return {
      numeroSerie: entry.numeroSerie,
      statut: entry.statut,
      identifiantAcEmettrice: entry.identifiantAcEmettrice,
      motifInvalidation: entry.motifInvalidation ?? null,
      dateInvalidation: entry.dateInvalidation ?? null,
      horodatageVerification: now,
      identifiantAv: this.id,
    };
  }

  public validerCertificat(
    requete: ValidationCertificatRequete
  ): ValidationCertificatReponse {
    const now = new Date();
    const horodatageValidation = now.toISOString();
    const cheminReponse = this.annuaire.getCheminCertification(
      requete.numeroSerieCertificat
    );

    if (
      !cheminReponse ||
      !cheminReponse.chaineCertificats ||
      cheminReponse.chaineCertificats.length === 0
    ) {
      const statutCourant = this.obtenirStatut(requete.numeroSerieCertificat).statut;
      return {
        valide: false,
        numeroSerieCertificat: requete.numeroSerieCertificat,
        statutCourant,
        detailsEtapes: {
          etape1PeriodeValiditeOk: false,
          etape2SignatureEtCheminOk: false,
          etape3StatutAvOk: false,
          etape4PolitiqueUsageOk: false,
          messageDiagnostic: `Échec de validation : certificat '${requete.numeroSerieCertificat}' introuvable dans l'Annuaire (statut ${statutCourant}).`,
        },
        cheminCertification: [],
        horodatageValidation,
      };
    }

    const chaine = cheminReponse.chaineCertificats;
    const leafCert = chaine[0];
    const statutCourant = this.obtenirStatut(leafCert.numeroSerie).statut;

    const formattedChemin: string[] = chaine.map((c, idx) => {
      if (idx === 0) {
        return `${c.numeroSerie} (Sujet: ${c.sujet})`;
      }
      if (c.sujet === c.identifiantAcEmettrice) {
        return `${c.numeroSerie} (${c.sujet} - Auto-signé)`;
      }
      return `${c.numeroSerie} (${c.sujet})`;
    });

    // Step 1: Contrôle de la période de validité
    let etape1PeriodeValiditeOk = true;
    for (const cert of chaine) {
      const debut = new Date(cert.dateDebutValidite).getTime();
      const fin = new Date(cert.dateFinValidite).getTime();
      const tNow = now.getTime();
      if (Number.isNaN(debut) || Number.isNaN(fin) || tNow < debut || tNow > fin) {
        etape1PeriodeValiditeOk = false;
        break;
      }
    }

    // Step 2: Vérification de la signature et du chemin de certification
    let etape2SignatureEtCheminOk = true;
    const rootCert = chaine[chaine.length - 1];
    if (rootCert.sujet !== rootCert.identifiantAcEmettrice) {
      etape2SignatureEtCheminOk = false;
    } else if (!verifyCertificatSignature(rootCert, rootCert.clePublique)) {
      etape2SignatureEtCheminOk = false;
    }

    if (etape2SignatureEtCheminOk) {
      for (let i = 1; i < chaine.length; i++) {
        if (chaine[i].usage !== 'CERTIFICATION_AC') {
          etape2SignatureEtCheminOk = false;
          break;
        }
      }
    }

    if (etape2SignatureEtCheminOk) {
      for (let i = 0; i < chaine.length - 1; i++) {
        const child = chaine[i];
        const parent = chaine[i + 1];
        if (child.identifiantAcEmettrice !== parent.sujet) {
          etape2SignatureEtCheminOk = false;
          break;
        }
        if (!verifyCertificatSignature(child, parent.clePublique)) {
          etape2SignatureEtCheminOk = false;
          break;
        }
      }
    }

    // Step 3: Contrôle de l'état du certificat et des AC auprès de l'AV
    let etape3StatutAvOk = true;
    for (const cert of chaine) {
      const rep = this.obtenirStatut(cert.numeroSerie);
      if (rep.statut !== 'VALIDE') {
        etape3StatutAvOk = false;
        break;
      }
    }

    // Step 4: Contrôle de la politique d'usage du certificat
    let etape4PolitiqueUsageOk = false;
    if (leafCert.usage === 'SIGNATURE_ET_CHIFFREMENT') {
      etape4PolitiqueUsageOk =
        requete.usageAttendu === 'SIGNATURE' ||
        requete.usageAttendu === 'CHIFFREMENT' ||
        requete.usageAttendu === 'SIGNATURE_ET_CHIFFREMENT';
    } else if (leafCert.usage === 'SIGNATURE') {
      etape4PolitiqueUsageOk = requete.usageAttendu === 'SIGNATURE';
    } else if (leafCert.usage === 'CHIFFREMENT') {
      etape4PolitiqueUsageOk = requete.usageAttendu === 'CHIFFREMENT';
    } else if (leafCert.usage === 'CERTIFICATION_AC') {
      etape4PolitiqueUsageOk = requete.usageAttendu === 'CERTIFICATION_AC';
    }

    if (etape4PolitiqueUsageOk && requete.sujetAttendu) {
      if (leafCert.sujet !== requete.sujetAttendu) {
        etape4PolitiqueUsageOk = false;
      }
    }

    const valide =
      etape1PeriodeValiditeOk &&
      etape2SignatureEtCheminOk &&
      etape3StatutAvOk &&
      etape4PolitiqueUsageOk;

    let messageDiagnostic = '';
    if (valide) {
      const acNames = chaine.slice(1).map((c) => c.sujet).join(' -> ');
      messageDiagnostic = `Certificat valide : période active, chaîne de confiance vérifiée (${acNames}), statut VALIDE, usage ${leafCert.usage} conforme.`;
    } else {
      const causes: string[] = [];
      if (!etape1PeriodeValiditeOk) {
        causes.push('Étape 1 (période de validité expirée ou non encore active)');
      }
      if (!etape2SignatureEtCheminOk) {
        causes.push(
          'Étape 2 (signature invalide, usage intermédiaire incorrect ou rupture du chemin)'
        );
      }
      if (!etape3StatutAvOk) {
        causes.push(`Étape 3 (statut non valide : ${statutCourant})`);
      }
      if (!etape4PolitiqueUsageOk) {
        causes.push(
          `Étape 4 (incompatibilité de l'usage '${leafCert.usage}' avec l'usage attendu '${requete.usageAttendu}' ou sujet divergent)`
        );
      }
      messageDiagnostic = `Échec de validation : ${causes.join(' ; ')}.`;
    }

    return {
      valide,
      numeroSerieCertificat: leafCert.numeroSerie,
      statutCourant,
      detailsEtapes: {
        etape1PeriodeValiditeOk,
        etape2SignatureEtCheminOk,
        etape3StatutAvOk,
        etape4PolitiqueUsageOk,
        messageDiagnostic,
      },
      cheminCertification: formattedChemin,
      horodatageValidation,
    };
  }

  public handleRequest(req: RestRequest): RestResponse {
    const cleanPath = req.path.split('?')[0].replace(/\/+$/, '');

    // 1. GET /av/{nature}/certificats/{numeroSerie}/statut
    const statutMatch = cleanPath.match(
      new RegExp(`^/av/${this.nature}/certificats/([^/]+)/statut$`)
    );
    if (req.method === 'GET' && statutMatch) {
      const numeroSerie = decodeURIComponent(statutMatch[1]);
      const statutReponse = this.obtenirStatut(numeroSerie);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: statutReponse,
      };
    }

    // 2. POST /av/{nature}/validations
    if (req.method === 'POST' && cleanPath === `/av/${this.nature}/validations`) {
      const body = req.body as Partial<ValidationCertificatRequete> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        !body.numeroSerieCertificat ||
        !body.usageAttendu
      ) {
        const err: ErreurApi = {
          code: 'REQUETE_INVALIDE',
          message:
            'Paramètres obligatoires manquants ou invalides : numeroSerieCertificat et usageAttendu sont requis.',
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      const validationReponse = this.validerCertificat(
        body as ValidationCertificatRequete
      );
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: validationReponse,
      };
    }

    const notFound: ErreurApi = {
      code: 'RESSOURCE_INTROUVABLE',
      message: `Ressource introuvable : ${req.method} ${cleanPath}`,
      horodatage: new Date().toISOString(),
      chemin: req.path,
    };
    return {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: notFound,
    };
  }
}

export class ServiceAutoriteValidation {
  private instances = new Map<NatureRessource, AutoriteValidation>();

  constructor(
    public readonly broker: InMemoryJmsBroker,
    public readonly annuaire: ServicePublication
  ) {}

  public enregistrerAv(av: AutoriteValidation): void {
    this.instances.set(av.nature, av);
  }

  public getAvParNature(nature: NatureRessource): AutoriteValidation {
    const av = this.instances.get(nature);
    if (!av) {
      throw new Error(
        `Aucune Autorité de Validation configurée pour la nature '${nature}'.`
      );
    }
    return av;
  }

  public handleRequest(req: RestRequest): RestResponse {
    const cleanPath = req.path.split('?')[0].replace(/\/+$/, '');
    const match = cleanPath.match(/^\/av\/([^/]+)(\/.*)?$/);
    if (!match) {
      const err: ErreurApi = {
        code: 'RESSOURCE_INTROUVABLE',
        message: `Ressource introuvable : ${req.method} ${cleanPath}`,
        horodatage: new Date().toISOString(),
        chemin: req.path,
      };
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: err,
      };
    }

    const natureStr = match[1] as NatureRessource;
    const av = this.instances.get(natureStr);
    if (!av) {
      const err: ErreurApi = {
        code: 'NATURE_RESSOURCE_INVALIDE',
        message: `Nature de ressource inconnue ou non gérée : '${natureStr}'.`,
        horodatage: new Date().toISOString(),
        chemin: req.path,
      };
      return {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
        body: err,
      };
    }

    return av.handleRequest(req);
  }
}

export function bootstrapAutoritesValidation(
  broker: InMemoryJmsBroker,
  annuaire: ServicePublication
): ServiceAutoriteValidation {
  const service = new ServiceAutoriteValidation(broker, annuaire);
  const natures: NatureRessource[] = [
    'messagerie',
    'routeurs',
    'services',
    'utilisateurs',
  ];

  for (const nature of natures) {
    const av = new AutoriteValidation({
      id: `AV-${nature.toUpperCase()}`,
      nature,
      broker,
      annuaire,
    });
    service.enregistrerAv(av);
  }

  // Pre-seed known certificates from Annuaire if any exist
  const existingCerts = annuaire.rechercherCertificats();
  for (const cert of existingCerts) {
    for (const nature of natures) {
      service.getAvParNature(nature).enregistrerCertificat(cert);
    }
  }

  return service;
}
