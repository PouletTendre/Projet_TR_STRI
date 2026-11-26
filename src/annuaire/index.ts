import { AMQP_EXCHANGES, InMemoryAmqpBroker } from '../amqp/index.js';
import type {
  AmqpMessage,
  AutoriteCertificationInfo,
  Certificat,
  CheminCertificationReponse,
  ErreurApi,
  ListeCertificatsRevoques,
  PublicationCertificatPayload,
  PublicationLcrPayload,
  RestRequest,
  RestResponse
} from '../types/index.js';

export const QUEUE_PUBLICATION_FLUX = 'q.pki.publication.flux';

function cloneCertificat(cert: Certificat): Certificat {
  return { ...cert };
}

function cloneLcr(lcr: ListeCertificatsRevoques): ListeCertificatsRevoques {
  return {
    ...lcr,
    entrees: lcr.entrees.map((e) => ({ ...e }))
  };
}

function cloneAutoriteInfo(info: AutoriteCertificationInfo): AutoriteCertificationInfo {
  return {
    ...info,
    certificatAc: cloneCertificat(info.certificatAc)
  };
}

function buildError(
  status: number,
  code: string,
  message: string,
  chemin: string
): RestResponse<ErreurApi> {
  return {
    status,
    body: {
      code,
      message,
      horodatage: new Date().toISOString(),
      chemin
    }
  };
}

function parsePathAndQuery(
  rawPath: string,
  explicitQuery?: Record<string, string | number | boolean | undefined>
): { normalizedPath: string; query: Record<string, string | number | boolean | undefined> } {
  const [pathOnly, queryString] = rawPath.split('?', 2);
  const query: Record<string, string | number | boolean | undefined> = {};

  if (queryString) {
    const searchParams = new URLSearchParams(queryString);
    for (const [key, value] of searchParams.entries()) {
      query[key] = value;
    }
  }

  if (explicitQuery) {
    for (const [key, value] of Object.entries(explicitQuery)) {
      if (value !== undefined) {
        query[key] = value;
      }
    }
  }

  let normalizedPath = pathOnly ?? '/';
  if (normalizedPath.startsWith('/api/v1')) {
    normalizedPath = normalizedPath.slice('/api/v1'.length) || '/';
  }
  if (normalizedPath.length > 1 && normalizedPath.endsWith('/')) {
    normalizedPath = normalizedPath.slice(0, -1);
  }

  return { normalizedPath, query };
}

function parseBooleanQuery(
  value: string | number | boolean | undefined,
  defaultValue: boolean
): boolean {
  if (value === undefined) {
    return defaultValue;
  }
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    const lower = value.trim().toLowerCase();
    if (lower === 'true' || lower === '1') {
      return true;
    }
    if (lower === 'false' || lower === '0') {
      return false;
    }
  }
  return defaultValue;
}

/**
 * Service de Publication (Annuaire partagé du Domaine de confiance).
 * Consomme en temps réel les certificats et LCR sur `q.pki.publication.flux`
 * et expose la façade REST `/annuaire/...`.
 */
export class ServicePublication {
  private readonly broker: InMemoryAmqpBroker;
  private readonly certificats = new Map<string, Certificat>();
  private readonly autorites = new Map<string, AutoriteCertificationInfo>();
  private readonly lcrs = new Map<string, ListeCertificatsRevoques>();
  private readonly initPromise: Promise<void>;
  private consumerTag: string | null = null;

  constructor(broker: InMemoryAmqpBroker) {
    this.broker = broker;
    this.broker.declareExchange(AMQP_EXCHANGES.PUBLICATIONS, 'topic', { durable: true });
    this.broker.declareQueue(QUEUE_PUBLICATION_FLUX, { durable: true });
    this.broker.bindQueue(QUEUE_PUBLICATION_FLUX, AMQP_EXCHANGES.PUBLICATIONS, '#');

    this.initPromise = this.broker
      .consume(QUEUE_PUBLICATION_FLUX, (message) => {
        this.traiterMessagePublication(message);
      })
      .then((tag) => {
        this.consumerTag = tag;
      });
  }

  async ready(): Promise<void> {
    await this.initPromise;
  }

  async arreter(): Promise<void> {
    await this.ready();
    if (this.consumerTag) {
      this.broker.unsubscribe(QUEUE_PUBLICATION_FLUX, this.consumerTag);
      this.consumerTag = null;
    }
  }

  handleRestRequest(req: RestRequest): RestResponse {
    const method = req.method.toUpperCase();
    const { normalizedPath, query } = parsePathAndQuery(req.path, req.query);

    if (method !== 'GET') {
      return buildError(
        405,
        'METHODE_NON_AUTORISEE',
        `Méthode HTTP "${method}" non supportée sur le Service de Publication.`,
        req.path
      );
    }

    if (normalizedPath === '/annuaire/certificats') {
      return this.rechercherCertificats(query);
    }

    const cheminMatch = /^\/annuaire\/certificats\/([^/]+)\/chemin-certification$/.exec(
      normalizedPath
    );
    if (cheminMatch && cheminMatch[1]) {
      return this.getCheminCertification(decodeURIComponent(cheminMatch[1]), req.path);
    }

    const certMatch = /^\/annuaire\/certificats\/([^/]+)$/.exec(normalizedPath);
    if (certMatch && certMatch[1]) {
      return this.getCertificatParNumeroSerie(decodeURIComponent(certMatch[1]), req.path);
    }

    if (normalizedPath === '/annuaire/autorites') {
      return this.listerAutorites(query, req.path);
    }

    const lcrAcMatch = /^\/annuaire\/autorites\/([^/]+)\/lcr$/.exec(normalizedPath);
    if (lcrAcMatch && lcrAcMatch[1]) {
      return this.getLcrParAutorite(decodeURIComponent(lcrAcMatch[1]), req.path);
    }

    if (normalizedPath === '/annuaire/lcr') {
      return this.getLcrConsolidee();
    }

    return buildError(
      404,
      'ROUTE_INTROUVABLE',
      `Ressource REST introuvable : "${req.path}".`,
      req.path
    );
  }

  private traiterMessagePublication(message: AmqpMessage): void {
    const type = message.properties.type;
    const payload = message.payload as Partial<
      PublicationCertificatPayload & PublicationLcrPayload
    > | null;

    if (!payload || typeof payload !== 'object') {
      return;
    }

    if (type === 'PUBLICATION_CERTIFICAT' || payload.certificat) {
      const cert = payload.certificat;
      if (cert) {
        this.certificats.set(cert.numeroSerie, cloneCertificat(cert));
      }
      if (payload.autoriteInfo) {
        this.autorites.set(
          payload.autoriteInfo.acId,
          cloneAutoriteInfo(payload.autoriteInfo)
        );
      }
      return;
    }

    if (type === 'PUBLICATION_LCR' || payload.lcr) {
      const lcr = payload.lcr;
      if (lcr) {
        const existing = this.lcrs.get(lcr.identifiantAc);
        if (!existing || lcr.numeroVersionLcr >= existing.numeroVersionLcr) {
          this.lcrs.set(lcr.identifiantAc, cloneLcr(lcr));
        }
      }
    }
  }

  private estCertificatValide(cert: Certificat, horodatageMs = Date.now()): boolean {
    const debutMs = Date.parse(cert.dateDebutValidite);
    const finMs = Date.parse(cert.dateFinValidite);
    if (Number.isNaN(debutMs) || Number.isNaN(finMs)) {
      return false;
    }
    if (horodatageMs < debutMs || horodatageMs > finMs) {
      return false;
    }

    const lcr = this.lcrs.get(cert.identifiantAcEmettrice);
    if (lcr) {
      const entree = lcr.entrees.find(
        (e) => e.numeroSerieCertificat === cert.numeroSerie
      );
      if (entree && (entree.statut === 'REVOQUE' || entree.statut === 'SUSPENDU')) {
        return false;
      }
    }

    return true;
  }

  private rechercherCertificats(
    query: Record<string, string | number | boolean | undefined>
  ): RestResponse<Certificat[]> {
    const sujet = typeof query.sujet === 'string' ? query.sujet : undefined;
    const acEmettriceId =
      typeof query.acEmettriceId === 'string' ? query.acEmettriceId : undefined;
    const usage = typeof query.usage === 'string' ? query.usage : undefined;
    const uniquementValides = parseBooleanQuery(query.uniquementValides, true);
    const nowMs = Date.now();

    const resultats: Certificat[] = [];
    for (const cert of this.certificats.values()) {
      if (sujet !== undefined && cert.sujet !== sujet) {
        continue;
      }
      if (acEmettriceId !== undefined && cert.identifiantAcEmettrice !== acEmettriceId) {
        continue;
      }
      if (usage !== undefined && cert.usage !== usage) {
        continue;
      }
      if (uniquementValides && !this.estCertificatValide(cert, nowMs)) {
        continue;
      }
      resultats.push(cloneCertificat(cert));
    }

    return {
      status: 200,
      body: resultats
    };
  }

  private getCertificatParNumeroSerie(
    numeroSerie: string,
    chemin: string
  ): RestResponse<Certificat | ErreurApi> {
    const cert = this.certificats.get(numeroSerie);
    if (!cert) {
      return buildError(
        404,
        'CERTIFICAT_INTROUVABLE',
        `Aucun certificat trouvé pour le numéro de série "${numeroSerie}".`,
        chemin
      );
    }

    return {
      status: 200,
      body: cloneCertificat(cert)
    };
  }

  private getCheminCertification(
    numeroSerie: string,
    chemin: string
  ): RestResponse<CheminCertificationReponse | ErreurApi> {
    const cible = this.certificats.get(numeroSerie);
    if (!cible) {
      return buildError(
        404,
        'CERTIFICAT_INTROUVABLE',
        `Aucun certificat trouvé pour le numéro de série "${numeroSerie}".`,
        chemin
      );
    }

    const chaine: Certificat[] = [cloneCertificat(cible)];
    const visitedSerials = new Set<string>([cible.numeroSerie]);

    let courant: Certificat = cible;
    while (courant.identifiantAcEmettrice !== courant.sujet) {
      const autoriteEmettrice = this.autorites.get(courant.identifiantAcEmettrice);
      if (!autoriteEmettrice) {
        break;
      }
      const certAc = autoriteEmettrice.certificatAc;
      if (visitedSerials.has(certAc.numeroSerie)) {
        break;
      }
      chaine.push(cloneCertificat(certAc));
      visitedSerials.add(certAc.numeroSerie);
      courant = certAc;
    }

    const profondeurHierarchie =
      cible.usage === 'CERTIFICATION_AC'
        ? chaine.length
        : Math.max(1, chaine.length - 1);

    return {
      status: 200,
      body: {
        numeroSerieCible: cible.numeroSerie,
        profondeurHierarchie,
        chaineCertificats: chaine
      }
    };
  }

  private listerAutorites(
    query: Record<string, string | number | boolean | undefined>,
    chemin: string
  ): RestResponse<AutoriteCertificationInfo[] | ErreurApi> {
    let filtreNiveau: number | undefined;
    if (query.niveau !== undefined) {
      const parsed =
        typeof query.niveau === 'number'
          ? query.niveau
          : Number.parseInt(String(query.niveau), 10);
      if (!Number.isInteger(parsed) || parsed < 1) {
        return buildError(
          400,
          'REQUETE_INVALIDE',
          `Le paramètre "niveau" doit être un entier positif.`,
          chemin
        );
      }
      filtreNiveau = parsed;
    }

    const liste = Array.from(this.autorites.values())
      .filter((a) => filtreNiveau === undefined || a.niveau === filtreNiveau)
      .sort((a, b) => a.niveau - b.niveau || a.acId.localeCompare(b.acId))
      .map(cloneAutoriteInfo);

    return {
      status: 200,
      body: liste
    };
  }

  private getLcrParAutorite(
    acId: string,
    chemin: string
  ): RestResponse<ListeCertificatsRevoques | ErreurApi> {
    const lcr = this.lcrs.get(acId);
    if (!lcr) {
      return buildError(
        404,
        'AUTORITE_INTROUVABLE',
        `Aucune LCR publiée trouvée pour l'AC "${acId}".`,
        chemin
      );
    }

    return {
      status: 200,
      body: cloneLcr(lcr)
    };
  }

  private getLcrConsolidee(): RestResponse<ListeCertificatsRevoques[]> {
    const toutes = Array.from(this.lcrs.values())
      .sort((a, b) => a.identifiantAc.localeCompare(b.identifiantAc))
      .map(cloneLcr);

    return {
      status: 200,
      body: toutes
    };
  }
}
