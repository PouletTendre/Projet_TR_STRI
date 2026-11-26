import type { HierarchieAc } from '../ac/index.js';
import { AMQP_EXCHANGES } from '../amqp/index.js';
import type {
  AmqpExchangeType,
  AutoriteCertificationInfo,
  Certificat,
  RestRequest,
  RestResponse
} from '../types/index.js';
import { buildRestError, normalizeRestPath } from '../utils/http.js';

export interface TopologieAcConfig {
  acRacineId: string;
  profondeur: number;
  autorites: AutoriteCertificationInfo[];
  niveaux: {
    niveau1: AutoriteCertificationInfo[];
    niveau2: AutoriteCertificationInfo[];
    niveau3: AutoriteCertificationInfo[];
  };
}

export interface EchangeAmqpConfig {
  nom: string;
  type: AmqpExchangeType;
  durable: boolean;
}

export interface ParametresAmqpConfig {
  echanges: {
    commandes: EchangeAmqpConfig;
    publications: EchangeAmqpConfig;
    chatMessages: EchangeAmqpConfig;
  };
  files: {
    acCommandes: string;
    aeReponses: string;
    publicationFlux: string;
    avFlux: string;
    chatInbox: string;
  };
}

export interface ConfigurationServerConfig {
  hierarchie: HierarchieAc;
  amqp?: ParametresAmqpConfig;
  horloge?: () => Date;
}

function cloneAutoriteInfo(info: AutoriteCertificationInfo): AutoriteCertificationInfo {
  return {
    ...info,
    certificatAc: { ...info.certificatAc }
  };
}

function construireParametresAmqpParDefaut(): ParametresAmqpConfig {
  return {
    echanges: {
      commandes: {
        nom: AMQP_EXCHANGES.COMMANDES,
        type: 'direct',
        durable: true
      },
      publications: {
        nom: AMQP_EXCHANGES.PUBLICATIONS,
        type: 'topic',
        durable: true
      },
      chatMessages: {
        nom: AMQP_EXCHANGES.CHAT_MESSAGES,
        type: 'direct',
        durable: true
      }
    },
    files: {
      acCommandes: 'q.pki.ac.<id_ac>.demandes',
      aeReponses: 'q.pki.ae.<id_ae>.reponses',
      publicationFlux: 'q.pki.publication.flux',
      avFlux: 'q.pki.av.<nature>.flux',
      chatInbox: 'q.chat.inbox.<id_correspondant>'
    }
  };
}

/**
 * Serveur de Configuration Edge distribuant la topologie hiérarchique des AC (niveaux 1, 2, 3),
 * le certificat auto-signé de l'AC Racine et les paramètres AMQP 0-9-1 du Domaine de confiance.
 */
export class ConfigurationServer {
  private readonly hierarchie: HierarchieAc;
  private readonly amqpConfig: ParametresAmqpConfig;
  private readonly horloge: () => Date;

  constructor(config: ConfigurationServerConfig) {
    this.hierarchie = config.hierarchie;
    this.amqpConfig = config.amqp ?? construireParametresAmqpParDefaut();
    this.horloge = config.horloge ?? (() => new Date());
  }

  getTopologieAc(): TopologieAcConfig {
    const autorites = Array.from(this.hierarchie.autorites.values())
      .map((ac) => cloneAutoriteInfo(ac.getInfo()))
      .sort((a, b) => a.niveau - b.niveau || a.acId.localeCompare(b.acId));

    const niveaux = {
      niveau1: autorites.filter((a) => a.niveau === 1),
      niveau2: autorites.filter((a) => a.niveau === 2),
      niveau3: autorites.filter((a) => a.niveau === 3)
    };

    const profondeur = autorites.reduce((max, a) => Math.max(max, a.niveau), 0);

    return {
      acRacineId: this.hierarchie.racine.acId,
      profondeur,
      autorites,
      niveaux
    };
  }

  getAncreRacine(): Certificat {
    return { ...this.hierarchie.racine.getCertificatAc() };
  }

  getConfigAmqp(): ParametresAmqpConfig {
    return {
      echanges: {
        commandes: { ...this.amqpConfig.echanges.commandes },
        publications: { ...this.amqpConfig.echanges.publications },
        chatMessages: { ...this.amqpConfig.echanges.chatMessages }
      },
      files: { ...this.amqpConfig.files }
    };
  }

  handleRestRequest(req: RestRequest): RestResponse {
    const method = req.method.toUpperCase();
    const normalizedPath = normalizeRestPath(req.path);
    const nowIso = this.horloge().toISOString();

    if (
      normalizedPath !== '/config/topologie-ac' &&
      normalizedPath !== '/config/ancre-racine' &&
      normalizedPath !== '/config/amqp'
    ) {
      return buildRestError(
        404,
        'ROUTE_INTROUVABLE',
        `Ressource de configuration introuvable : "${req.path}".`,
        req.path,
        nowIso
      );
    }

    if (method !== 'GET') {
      return buildRestError(
        405,
        'METHODE_NON_AUTORISEE',
        `Méthode HTTP "${method}" non supportée sur le Configuration Server.`,
        req.path,
        nowIso
      );
    }

    if (normalizedPath === '/config/topologie-ac') {
      return {
        status: 200,
        body: this.getTopologieAc()
      };
    }

    if (normalizedPath === '/config/ancre-racine') {
      return {
        status: 200,
        body: this.getAncreRacine()
      };
    }

    return {
      status: 200,
      body: this.getConfigAmqp()
    };
  }
}
