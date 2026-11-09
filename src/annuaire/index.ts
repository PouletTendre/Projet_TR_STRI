import { InMemoryJmsBroker, type JmsTextMessage } from '../broker/index.js';
import type {
  Certificat,
  AutoriteCertificationInfo,
  CheminCertificationReponse,
  ListeCertificatsRevoques,
  EntreeLcr,
  PublicationLcrPayload,
  ErreurApi,
  UsageCle,
  RestRequest,
  RestResponse,
} from '../types/index.js';

export type { RestRequest, RestResponse };


export class ServicePublication {
  private broker: InMemoryJmsBroker;
  private certificatsParNumeroSerie = new Map<string, Certificat>();
  private autoritesParId = new Map<string, AutoriteCertificationInfo>();
  private lcrsParAcId = new Map<string, ListeCertificatsRevoques>();
  private unsubscribeTopic: () => void;
  private unsubscribeLcr: () => void;

  constructor(broker: InMemoryJmsBroker) {
    this.broker = broker;
    this.unsubscribeTopic = this.broker.subscribe<Certificat>(
      'topic.pki.publications.certificats',
      (msg) => this.onCertificatPublie(msg)
    );
    this.unsubscribeLcr = this.broker.subscribe<PublicationLcrPayload>(
      'topic.pki.publications.lcr',
      (msg) => this.onLcrPublie(msg)
    );
  }

  public destroy(): void {
    if (this.unsubscribeTopic) {
      this.unsubscribeTopic();
    }
    if (this.unsubscribeLcr) {
      this.unsubscribeLcr();
    }
  }

  public onLcrPublie(message: JmsTextMessage<PublicationLcrPayload>): void {
    const payload = message.payload;
    if (!payload) return;

    if (payload.lcr) {
      this.lcrsParAcId.set(payload.lcr.identifiantAc, payload.lcr);
      return;
    }

    if (payload.identifiantAc) {
      const entrees: EntreeLcr[] = (payload.entreesActives ?? []).map((e) => ({
        numeroSerieCertificat: e.numeroSerieCertificat,
        statut: e.statut as 'REVOQUE' | 'SUSPENDU',
        dateInvalidation: e.dateInvalidation,
        motif: e.motif ?? '',
      }));

      this.lcrsParAcId.set(payload.identifiantAc, {
        identifiantAc: payload.identifiantAc,
        numeroVersionLcr: payload.numeroVersionLcr ?? 1,
        dateEmission: payload.dateEmission ?? new Date().toISOString(),
        prochaineMiseAJour: payload.prochaineMiseAJour ?? new Date().toISOString(),
        entrees,
        signatureAc: payload.signatureAc ?? '',
      });
    }
  }

  public getLcrParAutorite(acId: string): ListeCertificatsRevoques | null {
    return this.lcrsParAcId.get(acId) ?? null;
  }

  public getLcrConsolidee(): ListeCertificatsRevoques[] {
    return Array.from(this.lcrsParAcId.values());
  }

  public enregistrerLcr(lcr: ListeCertificatsRevoques): void {
    this.lcrsParAcId.set(lcr.identifiantAc, lcr);
  }

  public onCertificatPublie(message: JmsTextMessage<Certificat>): void {
    const cert = message.payload;
    if (!cert || !cert.numeroSerie) {
      return;
    }
    this.certificatsParNumeroSerie.set(cert.numeroSerie, cert);

    if (cert.usage === 'CERTIFICATION_AC') {
      const existing = this.autoritesParId.get(cert.sujet);
      if (existing) {
        existing.certificatAc = cert;
      } else {
        const niveau =
          cert.sujet === cert.identifiantAcEmettrice
            ? 1
            : (cert.niveauAcEmettrice ?? 1) + 1;
        const acParenteId =
          cert.sujet === cert.identifiantAcEmettrice
            ? null
            : cert.identifiantAcEmettrice;

        this.autoritesParId.set(cert.sujet, {
          acId: cert.sujet,
          nomOrganisationnel: cert.sujet,
          niveau,
          acParenteId,
          certificatAc: cert,
        });
      }
    }
  }

  public enregistrerAutorite(info: AutoriteCertificationInfo): void {
    this.autoritesParId.set(info.acId, info);
    this.certificatsParNumeroSerie.set(
      info.certificatAc.numeroSerie,
      info.certificatAc
    );
  }

  public enregistrerAutorites(infos: AutoriteCertificationInfo[]): void {
    for (const info of infos) {
      this.enregistrerAutorite(info);
    }
  }

  public listerAutorites(niveau?: number): AutoriteCertificationInfo[] {
    let list = Array.from(this.autoritesParId.values());
    if (niveau !== undefined && !Number.isNaN(niveau)) {
      list = list.filter((ac) => ac.niveau === niveau);
    }
    return list.sort((a, b) => {
      if (a.niveau !== b.niveau) {
        return a.niveau - b.niveau;
      }
      return a.acId.localeCompare(b.acId);
    });
  }

  public getCertificatParNumeroSerie(numeroSerie: string): Certificat | null {
    return this.certificatsParNumeroSerie.get(numeroSerie) ?? null;
  }

  public rechercherCertificats(criteres?: {
    numeroSerie?: string;
    sujet?: string;
    acEmettriceId?: string;
    usage?: UsageCle;
    uniquementValides?: boolean;
  }): Certificat[] {
    let results = Array.from(this.certificatsParNumeroSerie.values());
    if (criteres?.numeroSerie) {
      results = results.filter((c) => c.numeroSerie === criteres.numeroSerie);
    }
    if (criteres?.sujet) {
      results = results.filter((c) => c.sujet === criteres.sujet);
    }
    if (criteres?.acEmettriceId) {
      results = results.filter(
        (c) => c.identifiantAcEmettrice === criteres.acEmettriceId
      );
    }
    if (criteres?.usage) {
      results = results.filter((c) => c.usage === criteres.usage);
    }
    if (criteres?.uniquementValides) {
      const now = new Date();
      results = results.filter((c) => {
        const debut = new Date(c.dateDebutValidite);
        const fin = new Date(c.dateFinValidite);
        if (now < debut || now > fin) {
          return false;
        }
        for (const lcr of this.lcrsParAcId.values()) {
          const entree = lcr.entrees.find(
            (e) => e.numeroSerieCertificat === c.numeroSerie
          );
          if (
            entree &&
            (entree.statut === "SUSPENDU" || entree.statut === "REVOQUE")
          ) {
            return false;
          }
        }
        return true;
      });
    }
    return results;
  }

  public getCheminCertification(
    numeroSerie: string
  ): CheminCertificationReponse | null {
    const leafCert = this.getCertificatParNumeroSerie(numeroSerie);
    if (!leafCert) {
      return null;
    }

    const chaineCertificats: Certificat[] = [leafCert];
    let current = leafCert;
    const visited = new Set<string>([leafCert.numeroSerie]);

    while (current.identifiantAcEmettrice !== current.sujet) {
      let parentCert: Certificat | undefined = this.autoritesParId.get(
        current.identifiantAcEmettrice
      )?.certificatAc;

      if (!parentCert) {
        for (const cert of this.certificatsParNumeroSerie.values()) {
          if (
            cert.sujet === current.identifiantAcEmettrice &&
            cert.usage === 'CERTIFICATION_AC'
          ) {
            parentCert = cert;
            break;
          }
        }
      }

      if (!parentCert || visited.has(parentCert.numeroSerie)) {
        break;
      }

      visited.add(parentCert.numeroSerie);
      chaineCertificats.push(parentCert);
      current = parentCert;
    }

    const acCount = chaineCertificats.filter(
      (c) => c.usage === 'CERTIFICATION_AC'
    ).length;

    return {
      numeroSerieCible: numeroSerie,
      profondeurHierarchie: Math.max(1, acCount),
      chaineCertificats,
    };
  }

  public handleRequest(req: RestRequest): RestResponse {
    const cleanPath = req.path.split('?')[0].replace(/\/+$/, '');

    // 1. GET /annuaire/autorites
    if (req.method === 'GET' && cleanPath === '/annuaire/autorites') {
      const niveauParam = req.query?.niveau;
      const niveau = niveauParam ? parseInt(niveauParam, 10) : undefined;
      const list = this.listerAutorites(niveau);
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: list,
      };
    }

    // 2. GET /annuaire/certificats/{numeroSerie}/chemin-certification
    const cheminMatch = cleanPath.match(
      /^\/annuaire\/certificats\/([^/]+)\/chemin-certification$/
    );
    if (req.method === 'GET' && cheminMatch) {
      const numeroSerie = decodeURIComponent(cheminMatch[1]);
      const chemin = this.getCheminCertification(numeroSerie);
      if (!chemin) {
        const erreur: ErreurApi = {
          code: 'CERTIFICAT_INTROUVABLE',
          message: `Impossible de construire le chemin : certificat '${numeroSerie}' introuvable.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: erreur,
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: chemin,
      };
    }

    // 3. GET /annuaire/certificats/{numeroSerie}
    const certMatch = cleanPath.match(/^\/annuaire\/certificats\/([^/]+)$/);
    if (req.method === 'GET' && certMatch) {
      const numeroSerie = decodeURIComponent(certMatch[1]);
      const cert = this.getCertificatParNumeroSerie(numeroSerie);
      if (!cert) {
        const erreur: ErreurApi = {
          code: 'CERTIFICAT_INTROUVABLE',
          message: `Le certificat avec le numéro de série '${numeroSerie}' est introuvable.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: erreur,
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: cert,
      };
    }

    // 4. GET /annuaire/certificats
    if (req.method === 'GET' && cleanPath === '/annuaire/certificats') {
      const uniquementValidesParam = req.query?.uniquementValides;
      const uniquementValides =
        uniquementValidesParam === 'true'
          ? true
          : uniquementValidesParam === 'false'
          ? false
          : undefined;

      const results = this.rechercherCertificats({
        numeroSerie: req.query?.numeroSerie,
        sujet: req.query?.sujet,
        acEmettriceId: req.query?.acEmettriceId,
        usage: req.query?.usage as UsageCle | undefined,
        uniquementValides,
      });
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: results,
      };
    }

    // 5. GET /annuaire/autorites/{acId}/lcr
    const lcrAcMatch = cleanPath.match(/^\/annuaire\/autorites\/([^/]+)\/lcr$/);
    if (req.method === 'GET' && lcrAcMatch) {
      const acId = decodeURIComponent(lcrAcMatch[1]);
      const lcr = this.getLcrParAutorite(acId);
      if (!lcr) {
        const err: ErreurApi = {
          code: 'LCR_INTROUVABLE',
          message: `Aucune LCR trouvée pour l'Autorité de Certification '${acId}'.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: lcr,
      };
    }

    // 6. GET /annuaire/lcr (Consolidated LCR)
    if (req.method === 'GET' && cleanPath === '/annuaire/lcr') {
      const lcrs = this.getLcrConsolidee();
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: lcrs,
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
