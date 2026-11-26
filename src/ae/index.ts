import { randomUUID } from 'node:crypto';
import { AMQP_EXCHANGES, InMemoryAmqpBroker } from '../amqp/index.js';
import { hashPassword, verifyPassword } from '../crypto/index.js';
import type {
  AmqpMessage,
  Certificat,
  CommandeDemandeCertificationPayload,
  DemandeCertificationReponse,
  DemandeCertificationRequete,
  DroitsEntiteAE,
  EntiteAEInscription,
  EntiteAERegistre,
  ErreurApi,
  NatureRessource,
  ReponseDemandeCertificationPayload,
  RestRequest,
  RestResponse,
  StatutDemandeCertification,
  UsageCle
} from '../types/index.js';

interface DemandeCertificationSuivi {
  demandeId: string;
  statutDemande: StatutDemandeCertification;
  horodatage: string;
  certificat?: Certificat;
  erreur?: ErreurApi;
}

interface AttenteReponseCertification {
  resolve: (reponse: ReponseDemandeCertificationPayload) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface AutoriteEnregistrementConfig {
  nature: NatureRessource;
  broker: InMemoryAmqpBroker;
  entites?: EntiteAEInscription[];
  delaiReponseAcMs?: number;
  acsConnues?: string[];
}

export function queueAeReponses(aeId: string): string {
  return `q.pki.ae.${aeId}.reponses`;
}

export function routingKeyAe(aeId: string): string {
  return `ae.${aeId}`;
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

function normalizePath(rawPath: string): string {
  const [pathOnly] = rawPath.split('?', 2);
  let normalized = pathOnly ?? '/';
  if (normalized.startsWith('/api/v1')) {
    normalized = normalized.slice('/api/v1'.length) || '/';
  }
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

function getHeaderCaseInsensitive(
  headers: Record<string, string | undefined> | undefined,
  targetName: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lowerTarget = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerTarget) {
      return value;
    }
  }
  return undefined;
}

function parseBasicCredentials(
  authorizationHeader: string | undefined
): { nomEntite: string; motDePasse: string } | null {
  if (!authorizationHeader) {
    return null;
  }
  const match = /^Basic\s+(.+)$/i.exec(authorizationHeader.trim());
  if (!match || !match[1]) {
    return null;
  }
  try {
    const decoded = Buffer.from(match[1].trim(), 'base64').toString('utf8');
    const separatorIdx = decoded.indexOf(':');
    if (separatorIdx < 0) {
      return null;
    }
    return {
      nomEntite: decoded.slice(0, separatorIdx),
      motDePasse: decoded.slice(separatorIdx + 1)
    };
  } catch {
    return null;
  }
}

const USAGES_PORTEUR_AUTORISES = new Set<UsageCle>([
  'SIGNATURE',
  'CHIFFREMENT',
  'SIGNATURE_ET_CHIFFREMENT'
]);

function aDroitPourUsage(entite: EntiteAERegistre, usage: UsageCle): boolean {
  if (usage === 'SIGNATURE') {
    return entite.droitSignature;
  }
  if (usage === 'CHIFFREMENT') {
    return entite.droitChiffrement;
  }
  if (usage === 'SIGNATURE_ET_CHIFFREMENT') {
    return entite.droitSignature && entite.droitChiffrement;
  }
  return false;
}

/**
 * Autorité d'Enregistrement (AE) spécialisée par nature de Ressource.
 * Authentifie les Ressources, vérifie leurs droits et relaie les demandes
 * vers l'AC de niveau 3 via l'échangeur AMQP `ex.pki.commandes`.
 */
export class AutoriteEnregistrement {
  readonly nature: NatureRessource;
  readonly aeId: string;
  readonly queueReponses: string;
  readonly routingKeyReponses: string;

  private readonly broker: InMemoryAmqpBroker;
  private readonly entites = new Map<string, EntiteAERegistre>();
  private readonly acsConnues: Set<string> | null;
  private readonly delaiReponseAcMs: number;
  private readonly demandes = new Map<string, DemandeCertificationSuivi>();
  private readonly attentes = new Map<string, AttenteReponseCertification>();
  private readonly clesPriveesEphemeres = new Map<string, string>();
  private readonly initPromise: Promise<void>;
  private consumerTag: string | null = null;

  constructor(config: AutoriteEnregistrementConfig) {
    this.nature = config.nature;
    this.aeId = `ae-${config.nature}`;
    this.queueReponses = queueAeReponses(this.aeId);
    this.routingKeyReponses = routingKeyAe(this.aeId);
    this.broker = config.broker;
    this.delaiReponseAcMs = config.delaiReponseAcMs ?? 2000;
    this.acsConnues = config.acsConnues ? new Set(config.acsConnues) : null;

    this.broker.declareExchange(AMQP_EXCHANGES.COMMANDES, 'direct', { durable: true });
    this.broker.declareQueue(this.queueReponses, { durable: true });
    this.broker.bindQueue(
      this.queueReponses,
      AMQP_EXCHANGES.COMMANDES,
      this.routingKeyReponses
    );

    for (const entite of config.entites ?? []) {
      this.enregistrerEntite(entite);
    }

    this.initPromise = this.broker
      .consume(this.queueReponses, (message) => {
        this.traiterReponseAmqp(message);
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
    for (const [demandeId, attente] of this.attentes.entries()) {
      clearTimeout(attente.timer);
      this.attentes.delete(demandeId);
    }
    this.clesPriveesEphemeres.clear();
    if (this.consumerTag) {
      this.broker.unsubscribe(this.queueReponses, this.consumerTag);
      this.consumerTag = null;
    }
  }

  enregistrerEntite(entite: EntiteAEInscription): void {
    this.entites.set(entite.nomEntite, {
      nomEntite: entite.nomEntite,
      natureRessource: this.nature,
      motDePasseHash: hashPassword(entite.motDePasse),
      droitSignature: entite.droitSignature,
      droitChiffrement: entite.droitChiffrement,
      droitDemandeRevocation: entite.droitDemandeRevocation,
      acRattachementId: entite.acRattachementId
    });
  }

  private verifierRouteNatureEtMethode(
    rawNature: string,
    expectedMethod: string,
    actualMethod: string,
    rawPath: string
  ): RestResponse<ErreurApi> | null {
    const naturePath = decodeURIComponent(rawNature);
    if (naturePath !== this.nature) {
      return buildError(
        404,
        'RESSOURCE_INTROUVABLE',
        `Cette AE traite la nature "${this.nature}", pas "${naturePath}".`,
        rawPath
      );
    }
    if (actualMethod !== expectedMethod) {
      return buildError(
        405,
        'METHODE_NON_AUTORISEE',
        `Méthode HTTP "${actualMethod}" non supportée sur cette route.`,
        rawPath
      );
    }
    return null;
  }

  async handleRestRequest(req: RestRequest): Promise<RestResponse> {
    const method = req.method.toUpperCase();
    const normalizedPath = normalizePath(req.path);

    const droitsMatch = /^\/ae\/([^/]+)\/entites\/([^/]+)\/droits$/.exec(normalizedPath);
    if (droitsMatch && droitsMatch[1] && droitsMatch[2]) {
      const erreurRoute = this.verifierRouteNatureEtMethode(droitsMatch[1], 'GET', method, req.path);
      if (erreurRoute) {
        return erreurRoute;
      }
      return this.consulterDroitsEntite(decodeURIComponent(droitsMatch[2]), req);
    }

    const demandesMatch = /^\/ae\/([^/]+)\/demandes-certification$/.exec(normalizedPath);
    if (demandesMatch && demandesMatch[1]) {
      const erreurRoute = this.verifierRouteNatureEtMethode(demandesMatch[1], 'POST', method, req.path);
      if (erreurRoute) {
        return erreurRoute;
      }
      return this.soumettreDemandeCertification(req);
    }

    const demandeDetailMatch = /^\/ae\/([^/]+)\/demandes-certification\/([^/]+)$/.exec(
      normalizedPath
    );
    if (demandeDetailMatch && demandeDetailMatch[1] && demandeDetailMatch[2]) {
      const erreurRoute = this.verifierRouteNatureEtMethode(
        demandeDetailMatch[1],
        'GET',
        method,
        req.path
      );
      if (erreurRoute) {
        return erreurRoute;
      }
      return this.consulterDemandeCertification(
        decodeURIComponent(demandeDetailMatch[2]),
        req.path
      );
    }

    return buildError(
      404,
      'ROUTE_INTROUVABLE',
      `Ressource REST introuvable : "${req.path}".`,
      req.path
    );
  }

  private consulterDroitsEntite(
    nomEntite: string,
    req: RestRequest
  ): RestResponse<DroitsEntiteAE | ErreurApi> {
    const entite = this.entites.get(nomEntite);
    if (!entite) {
      return buildError(
        404,
        'ENTITE_INTROUVABLE',
        `Aucune entité "${nomEntite}" enregistrée dans l'AE "${this.aeId}".`,
        req.path
      );
    }

    const authHeader = getHeaderCaseInsensitive(req.headers, 'Authorization');
    const fallbackPassword = getHeaderCaseInsensitive(req.headers, 'X-Mot-De-Passe');

    let authenticated = false;
    if (authHeader !== undefined) {
      const basic = parseBasicCredentials(authHeader);
      if (
        basic &&
        basic.nomEntite === nomEntite &&
        verifyPassword(basic.motDePasse, entite.motDePasseHash)
      ) {
        authenticated = true;
      }
    } else if (fallbackPassword !== undefined) {
      authenticated = verifyPassword(fallbackPassword, entite.motDePasseHash);
    }

    if (!authenticated) {
      return buildError(
        401,
        'NON_AUTHENTIFIE',
        `Échec d'authentification pour l'entité "${nomEntite}".`,
        req.path
      );
    }

    return {
      status: 200,
      body: {
        nomEntite: entite.nomEntite,
        natureRessource: this.nature,
        droitSignature: entite.droitSignature,
        droitChiffrement: entite.droitChiffrement,
        droitDemandeRevocation: entite.droitDemandeRevocation,
        acRattachementId: entite.acRattachementId
      }
    };
  }

  private estAcCibleValide(acCibleId: string): boolean {
    if (this.acsConnues) {
      return this.acsConnues.has(acCibleId);
    }
    const targetRoutingKey = `ac.${acCibleId}`;
    return this.broker
      .listBindings()
      .some(
        (b) =>
          b.exchange === AMQP_EXCHANGES.COMMANDES && b.routingKey === targetRoutingKey
      );
  }

  private async soumettreDemandeCertification(
    req: RestRequest
  ): Promise<RestResponse<DemandeCertificationReponse | ErreurApi>> {
    const body = req.body as Partial<DemandeCertificationRequete> | null | undefined;
    if (!body || typeof body !== 'object') {
      return buildError(
        400,
        'REQUETE_INVALIDE',
        'Le corps de la demande de certification est requis.',
        req.path
      );
    }

    if (typeof body.nomEntite !== 'string' || body.nomEntite.trim() === '') {
      return buildError(
        400,
        'REQUETE_INVALIDE',
        'Le champ "nomEntite" doit être une chaîne non vide.',
        req.path
      );
    }

    if (typeof body.motDePasse !== 'string' || body.motDePasse === '') {
      return buildError(
        400,
        'REQUETE_INVALIDE',
        'Le champ "motDePasse" est requis.',
        req.path
      );
    }

    if (typeof body.usage !== 'string' || !USAGES_PORTEUR_AUTORISES.has(body.usage as UsageCle)) {
      return buildError(
        400,
        'REQUETE_INVALIDE',
        'Le champ "usage" doit être SIGNATURE, CHIFFREMENT ou SIGNATURE_ET_CHIFFREMENT.',
        req.path
      );
    }

    if (body.genererBicle !== undefined && typeof body.genererBicle !== 'boolean') {
      return buildError(
        400,
        'REQUETE_INVALIDE',
        'Le champ "genererBicle" doit être un booléen.',
        req.path
      );
    }

    const genererBicle = body.genererBicle ?? false;
    if (!genererBicle && (typeof body.clePublique !== 'string' || body.clePublique.trim() === '')) {
      return buildError(
        400,
        'REQUETE_INVALIDE',
        'Le champ "clePublique" est obligatoire lorsque "genererBicle" vaut false.',
        req.path
      );
    }

    const entite = this.entites.get(body.nomEntite);
    if (!entite || !verifyPassword(body.motDePasse, entite.motDePasseHash)) {
      return buildError(
        401,
        'NON_AUTHENTIFIE',
        `Échec d'authentification pour l'entité "${body.nomEntite}".`,
        req.path
      );
    }

    const usage = body.usage as UsageCle;
    if (!aDroitPourUsage(entite, usage)) {
      return buildError(
        403,
        'DROITS_INSUFFISANTS',
        `L'entité "${entite.nomEntite}" ne dispose pas des droits requis pour l'usage "${usage}".`,
        req.path
      );
    }

    const acCibleId =
      typeof body.acCibleId === 'string' && body.acCibleId.trim() !== ''
        ? body.acCibleId.trim()
        : entite.acRattachementId;

    if (!this.estAcCibleValide(acCibleId)) {
      return buildError(
        404,
        'AUTORITE_INTROUVABLE',
        `AC cible de niveau 3 introuvable : "${acCibleId}".`,
        req.path
      );
    }

    const demandeId = randomUUID();
    const horodatage = new Date().toISOString();
    this.demandes.set(demandeId, {
      demandeId,
      statutDemande: 'EN_ATTENTE_AC',
      horodatage
    });

    await this.ready();

    const reponsePromise = new Promise<ReponseDemandeCertificationPayload | null>((resolve) => {
      const timer = setTimeout(() => {
        this.attentes.delete(demandeId);
        resolve(null);
      }, this.delaiReponseAcMs);
      this.attentes.set(demandeId, {
        resolve: (payload) => resolve(payload),
        timer
      });
    });

    const commandePayload: CommandeDemandeCertificationPayload = {
      demandeId,
      sujet: entite.nomEntite,
      natureRessource: this.nature,
      acCibleId,
      usage,
      ...(typeof body.clePublique === 'string' && body.clePublique.trim() !== ''
        ? { clePublique: body.clePublique }
        : {}),
      genererBicle
    };

    await this.broker.publish(
      AMQP_EXCHANGES.COMMANDES,
      `ac.${acCibleId}`,
      commandePayload,
      {
        type: 'DEMANDE_CERTIFICATION',
        correlation_id: demandeId,
        reply_to: this.routingKeyReponses,
        headers: {
          aeId: this.aeId,
          natureRessource: this.nature
        }
      }
    );

    const reponseAc = await reponsePromise;
    if (!reponseAc) {
      return {
        status: 202,
        headers: {
          Location: `/api/v1/ae/${this.nature}/demandes-certification/${demandeId}`
        },
        body: {
          demandeId,
          statutDemande: 'EN_ATTENTE_AC',
          horodatage,
          clePriveeGeneree: null
        }
      };
    }

    // La clé privée générée éventuelle est transmise directement et n'est jamais conservée par l'AE.
    this.clesPriveesEphemeres.delete(demandeId);

    if (reponseAc.statut === 'REJETEE' || !reponseAc.certificat) {
      return buildError(
        400,
        reponseAc.erreur?.code ?? 'DEMANDE_REJETEE',
        reponseAc.erreur?.message ?? 'La demande de certification a été rejetée par l’AC.',
        req.path
      );
    }

    const suivi = this.demandes.get(demandeId);
    return {
      status: 201,
      body: {
        demandeId,
        statutDemande: 'EMISE',
        horodatage: suivi?.horodatage ?? new Date().toISOString(),
        certificat: { ...reponseAc.certificat },
        clePriveeGeneree: reponseAc.clePriveeGeneree ?? null
      }
    };
  }

  private consulterDemandeCertification(
    demandeId: string,
    chemin: string
  ): RestResponse<DemandeCertificationReponse | ErreurApi> {
    const suivi = this.demandes.get(demandeId);
    if (!suivi) {
      return buildError(
        404,
        'DEMANDE_INTROUVABLE',
        `Aucune demande de certification trouvée pour l'identifiant "${demandeId}".`,
        chemin
      );
    }

    const clePriveeOneTime = this.clesPriveesEphemeres.get(demandeId) ?? null;
    if (clePriveeOneTime !== null) {
      this.clesPriveesEphemeres.delete(demandeId);
    }

    return {
      status: 200,
      body: {
        demandeId: suivi.demandeId,
        statutDemande: suivi.statutDemande,
        horodatage: suivi.horodatage,
        ...(suivi.certificat ? { certificat: { ...suivi.certificat } } : {}),
        clePriveeGeneree: clePriveeOneTime
      }
    };
  }

  private traiterReponseAmqp(message: AmqpMessage): void {
    if (message.properties.type !== 'REPONSE_CERTIFICATION') {
      return;
    }

    const payload = message.payload as Partial<ReponseDemandeCertificationPayload> | null;
    const demandeId = message.properties.correlation_id ?? payload?.demandeId;
    if (!demandeId || !payload) {
      return;
    }

    const suivi = this.demandes.get(demandeId);
    if (!suivi) {
      return;
    }

    const nowIso = new Date().toISOString();
    suivi.horodatage = nowIso;

    if (payload.statut === 'EMISE' && payload.certificat) {
      suivi.statutDemande = 'EMISE';
      suivi.certificat = { ...payload.certificat };
    } else {
      suivi.statutDemande = 'REJETEE';
    }

    const attente = this.attentes.get(demandeId);
    if (attente) {
      clearTimeout(attente.timer);
      this.attentes.delete(demandeId);
      attente.resolve({
        demandeId,
        statut: payload.statut === 'EMISE' ? 'EMISE' : 'REJETEE',
        ...(payload.certificat ? { certificat: { ...payload.certificat } } : {}),
        clePriveeGeneree: payload.clePriveeGeneree ?? null,
        ...(payload.erreur ? { erreur: payload.erreur } : {})
      });
      return;
    }

    // Réponse différée (après timeout HTTP 202) : tampon éphémère à lecture unique.
    if (payload.statut === 'EMISE' && typeof payload.clePriveeGeneree === 'string') {
      this.clesPriveesEphemeres.set(demandeId, payload.clePriveeGeneree);
    }
  }
}
