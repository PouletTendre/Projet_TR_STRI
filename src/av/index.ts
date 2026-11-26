import { AMQP_EXCHANGES, InMemoryAmqpBroker } from '../amqp/index.js';
import type {
  AmqpMessage,
  Certificat,
  ListeCertificatsRevoques,
  NatureRessource,
  PublicationCertificatPayload,
  PublicationLcrPayload,
  RestRequest,
  RestResponse,
  StatutCertificatReponse
} from '../types/index.js';
import { buildRestError, normalizeRestPath } from '../utils/http.js';

const NATURES_STD = new Set<string>([
  'messagerie',
  'routeurs',
  'services',
  'utilisateurs'
]);

export function queueAvFlux(nature: NatureRessource): string {
  return `q.pki.av.${nature}.flux`;
}

export interface AutoriteValidationConfig {
  nature: NatureRessource;
  broker: InMemoryAmqpBroker;
  horloge?: () => Date;
}

function cloneCertificat(cert: Certificat): Certificat {
  return { ...cert };
}

function cloneLcr(lcr: ListeCertificatsRevoques): ListeCertificatsRevoques {
  return {
    ...lcr,
    entrees: lcr.entrees.map((e) => ({ ...e }))
  };
}

/**
 * Autorité de Validation (AV) spécialisée par nature de Ressource.
 * Maintient en temps réel via AMQP (`q.pki.av.<nature>.flux`) l'état courant
 * des Certificats de sa nature et de la hiérarchie d'AC, et expose uniquement
 * `GET /av/{nature}/certificats/{numeroSerie}/statut`.
 */
export class AutoriteValidation {
  readonly nature: NatureRessource;
  readonly avId: string;
  readonly queueFlux: string;

  private readonly broker: InMemoryAmqpBroker;
  private readonly horloge: () => Date;
  private readonly certificats = new Map<string, Certificat>();
  private readonly lcrs = new Map<string, ListeCertificatsRevoques>();
  private readonly initPromise: Promise<void>;
  private consumerTag: string | null = null;

  constructor(config: AutoriteValidationConfig) {
    this.nature = config.nature;
    this.avId = `av-${config.nature}`;
    this.queueFlux = queueAvFlux(config.nature);
    this.broker = config.broker;
    this.horloge = config.horloge ?? (() => new Date());

    this.broker.declareExchange(AMQP_EXCHANGES.PUBLICATIONS, 'topic', { durable: true });
    this.broker.declareQueue(this.queueFlux, { durable: true });
    this.broker.bindQueue(
      this.queueFlux,
      AMQP_EXCHANGES.PUBLICATIONS,
      `certificat.*.${this.nature}`
    );
    this.broker.bindQueue(this.queueFlux, AMQP_EXCHANGES.PUBLICATIONS, 'certificat.*.ac');
    this.broker.bindQueue(this.queueFlux, AMQP_EXCHANGES.PUBLICATIONS, 'lcr.#');

    this.initPromise = this.broker
      .consume(this.queueFlux, (message) => {
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
      this.broker.unsubscribe(this.queueFlux, this.consumerTag);
      this.consumerTag = null;
    }
  }

  handleRestRequest(req: RestRequest): RestResponse {
    const method = req.method.toUpperCase();
    const normalizedPath = normalizeRestPath(req.path);
    const nowIso = this.horloge().toISOString();

    const statutMatch = /^\/av\/([^/]+)\/certificats\/([^/]+)\/statut$/.exec(normalizedPath);
    if (!statutMatch || !statutMatch[1] || !statutMatch[2]) {
      return buildRestError(
        404,
        'ROUTE_INTROUVABLE',
        `Ressource REST introuvable sur l'AV "${this.avId}" : "${req.path}".`,
        req.path,
        nowIso
      );
    }

    const naturePath = decodeURIComponent(statutMatch[1]).trim();
    const numeroSerie = decodeURIComponent(statutMatch[2]).trim();

    if (!naturePath || !numeroSerie) {
      return buildRestError(
        400,
        'REQUETE_INVALIDE',
        'La nature de ressource et le numéro de série sont obligatoires.',
        req.path,
        nowIso
      );
    }

    if (naturePath !== this.nature) {
      if (!NATURES_STD.has(naturePath)) {
        return buildRestError(
          400,
          'NATURE_INVALIDE',
          `Nature de ressource invalide : "${naturePath}".`,
          req.path,
          nowIso
        );
      }
      return buildRestError(
        404,
        'RESSOURCE_INTROUVABLE',
        `Cette AV traite la nature "${this.nature}", pas "${naturePath}".`,
        req.path,
        nowIso
      );
    }

    if (method !== 'GET') {
      return buildRestError(
        405,
        'METHODE_NON_AUTORISEE',
        `Méthode HTTP "${method}" non supportée sur cette route.`,
        req.path,
        nowIso
      );
    }

    return this.consulterStatut(numeroSerie, nowIso);
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
      if (!cert) {
        return;
      }
      const estAc =
        cert.usage === 'CERTIFICATION_AC' ||
        cert.natureRessource === 'autorite_certification' ||
        payload.autoriteInfo !== undefined;

      if (estAc || cert.natureRessource === this.nature) {
        this.certificats.set(cert.numeroSerie, cloneCertificat(cert));
      }
      return;
    }

    if (type === 'PUBLICATION_LCR' || payload.lcr) {
      const lcr = payload.lcr;
      if (
        lcr &&
        typeof lcr.identifiantAc === 'string' &&
        typeof lcr.numeroVersionLcr === 'number' &&
        Array.isArray(lcr.entrees)
      ) {
        const existing = this.lcrs.get(lcr.identifiantAc);
        if (!existing || lcr.numeroVersionLcr >= existing.numeroVersionLcr) {
          this.lcrs.set(lcr.identifiantAc, cloneLcr(lcr));
        }
      }
    }
  }

  private consulterStatut(
    numeroSerie: string,
    horodatageVerification: string
  ): RestResponse<StatutCertificatReponse> {
    const cert = this.certificats.get(numeroSerie);
    if (!cert) {
      return {
        status: 200,
        body: {
          numeroSerie,
          statut: 'INCONNU',
          identifiantAcEmettrice: null,
          motifInvalidation: null,
          dateInvalidation: null,
          horodatageVerification,
          identifiantAv: this.avId
        }
      };
    }

    const lcr = this.lcrs.get(cert.identifiantAcEmettrice);
    const entree = lcr?.entrees.find((e) => e.numeroSerieCertificat === cert.numeroSerie);

    if (entree && (entree.statut === 'REVOQUE' || entree.statut === 'SUSPENDU')) {
      return {
        status: 200,
        body: {
          numeroSerie: cert.numeroSerie,
          statut: entree.statut,
          identifiantAcEmettrice: cert.identifiantAcEmettrice,
          motifInvalidation: entree.motif,
          dateInvalidation: entree.dateInvalidation,
          horodatageVerification,
          identifiantAv: this.avId
        }
      };
    }

    return {
      status: 200,
      body: {
        numeroSerie: cert.numeroSerie,
        statut: 'VALIDE',
        identifiantAcEmettrice: cert.identifiantAcEmettrice,
        motifInvalidation: null,
        dateInvalidation: null,
        horodatageVerification,
        identifiantAv: this.avId
      }
    };
  }
}
