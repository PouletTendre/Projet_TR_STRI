import crypto from 'node:crypto';
import { InMemoryJmsBroker, type JmsTextMessage } from '../broker/index.js';
import type { ServicePublication } from '../annuaire/index.js';
import type {
  NatureRessource,
  DroitsEntiteAE,
  EntiteAERegistre,
  StatutDemandeCertification,
  DemandeCertificationRequete,
  DemandeCertificationReponse,
  DemandeRevocationRequete,
  DemandeRevocationReponse,
  Certificat,
  RestRequest,
  RestResponse,
  ErreurApi,
  UsageCle,
} from '../types/index.js';

export interface EnregistrerEntiteOptions {
  nomEntite: string;
  motDePasse: string;
  natureRessource?: NatureRessource;
  droitSignature?: boolean;
  droitChiffrement?: boolean;
  droitDemandeRevocation?: boolean;
  acRattachementId: string;
}

export function hashPassword(password: string, salt: string): string {
  return crypto.createHash('sha256').update(`${salt}:${password}`).digest('hex');
}

export class AutoriteEnregistrement {
  public readonly id: string;
  public readonly nature: NatureRessource;
  public readonly broker: InMemoryJmsBroker;
  public readonly annuaire?: ServicePublication;
  private entites = new Map<string, EntiteAERegistre>();
  private demandesParId = new Map<string, DemandeCertificationReponse>();
  private certificatsConnus = new Map<string, Certificat>();
  private unsubscribeCertificats: () => void;
  private pendingReplies = new Map<
    string,
    {
      resolve: (value: any) => void;
      reject: (reason?: any) => void;
      timer: NodeJS.Timeout;
    }
  >();

  constructor(options: {
    id: string;
    nature: NatureRessource;
    broker: InMemoryJmsBroker;
    annuaire?: ServicePublication;
  }) {
    this.id = options.id;
    this.nature = options.nature;
    this.broker = options.broker;
    this.annuaire = options.annuaire;
    this.demarrerEcouteReponses();

    this.unsubscribeCertificats = this.broker.subscribe<Certificat>(
      'topic.pki.publications.certificats',
      (msg) => {
        if (msg.payload?.numeroSerie) {
          this.certificatsConnus.set(msg.payload.numeroSerie, msg.payload);
        }
      }
    );
  }

  public destroy(): void {
    if (this.unsubscribeCertificats) {
      this.unsubscribeCertificats();
    }
  }

  public getCertificat(numeroSerie: string): Certificat | undefined {
    return (
      this.certificatsConnus.get(numeroSerie) ??
      this.annuaire?.getCertificatParNumeroSerie(numeroSerie) ??
      undefined
    );
  }

  private demarrerEcouteReponses(): void {
    const queueName = `queue.pki.ae.${this.id}.reponses`;
    this.broker.registerQueueConsumer(queueName, (message) => {
      this.traiterMessageReponse(message);
    });
  }

  private traiterMessageReponse(message: JmsTextMessage): void {
    const correlationId = (message.headers.JMSCorrelationID as string) || (message.payload as any)?.demandeId;
    if (correlationId && this.pendingReplies.has(correlationId)) {
      const pending = this.pendingReplies.get(correlationId)!;
      clearTimeout(pending.timer);
      this.pendingReplies.delete(correlationId);
      pending.resolve(message.payload);
    }
  }

  private async traiterDemandeCertification(
    reqBody: DemandeCertificationRequete,
    entite: EntiteAERegistre
  ): Promise<RestResponse> {
    const demandeId = crypto.randomUUID();
    const acCibleId = reqBody.acCibleId ?? entite.acRattachementId;

    return new Promise<RestResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(demandeId);
        const err: ErreurApi = {
          code: 'AC_INDISPONIBLE',
          message: `L'AC cible '${acCibleId}' n'a pas répondu dans le délai imparti.`,
          horodatage: new Date().toISOString(),
          chemin: `/ae/${this.nature}/demandes-certification`,
        };
        resolve({
          status: 504,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        });
      }, 5000);

      this.pendingReplies.set(demandeId, {
        resolve: (payload: any) => {
          const reponse: DemandeCertificationReponse = {
            demandeId,
            statutDemande: payload.statut === 'SUCCES' ? 'EMISE' : 'REJETEE',
            horodatage: new Date().toISOString(),
            certificat: payload.certificat,
            clePriveeGeneree: payload.clePriveeGeneree ?? null,
          };

          // Store demand in local registry (without private key)
          this.demandesParId.set(demandeId, {
            demandeId,
            statutDemande: reponse.statutDemande,
            horodatage: reponse.horodatage,
            certificat: reponse.certificat,
            clePriveeGeneree: null,
          });

          resolve({
            status: 201,
            headers: { 'Content-Type': 'application/json' },
            body: reponse,
          });
        },
        reject: () => {},
        timer,
      });

      // Dispatch to JMS queue queue.pki.ac.<acCibleId>.demandes
      this.broker.sendToQueue(`queue.pki.ac.${acCibleId}.demandes`, {
        headers: {
          JMSCorrelationID: demandeId,
          JMSReplyTo: `queue.pki.ae.${this.id}.reponses`,
          type_message: 'DEMANDE_CERTIFICATION',
          ae_emettrice_id: this.id,
          nature_ressource: this.nature,
          ac_cible_id: acCibleId,
        },
        payload: {
          demandeId,
          sujet: entite.nomEntite,
          natureRessource: this.nature,
          usageAutorise: reqBody.usage,
          clePublique: reqBody.genererBicle ? null : reqBody.clePublique,
          genererBicle: !!reqBody.genererBicle,
          aeAuthentification: {
            aeId: this.id,
            horodatageVerification: new Date().toISOString(),
            droitSignatureVerifie: entite.droitSignature,
            droitChiffrementVerifie: entite.droitChiffrement,
          },
        },
      });
    });
  }

  private async traiterDemandeRevocation(
    reqBody: DemandeRevocationRequete,
    entite: EntiteAERegistre,
    cert: Certificat
  ): Promise<RestResponse> {
    const demandeId = crypto.randomUUID();
    const acCibleId = cert.identifiantAcEmettrice;

    return new Promise<RestResponse>((resolve) => {
      const timer = setTimeout(() => {
        this.pendingReplies.delete(demandeId);
        const err: ErreurApi = {
          code: 'AC_INDISPONIBLE',
          message: `L'AC cible '${acCibleId}' n'a pas répondu dans le délai imparti.`,
          horodatage: new Date().toISOString(),
          chemin: `/ae/${this.nature}/demandes-revocation`,
        };
        resolve({
          status: 504,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        });
      }, 5000);

      this.pendingReplies.set(demandeId, {
        resolve: (payload: any) => {
          if (payload.statut === 'SUCCES') {
            const reponse: DemandeRevocationReponse = {
              demandeId,
              numeroSerieCertificat: payload.numeroSerieCertificat,
              identifiantAc: payload.identifiantAc,
              actionAppliquee: payload.actionAppliquee,
              nouvelEtatCertificat: payload.nouvelEtatCertificat,
              horodatagePublicationLcr: payload.horodatagePublicationLcr,
            };
            resolve({
              status: 200,
              headers: { 'Content-Type': 'application/json' },
              body: reponse,
            });
          } else {
            const statusCode = payload.statusCode ?? 409;
            const err: ErreurApi = {
              code: payload.codeErreur ?? 'TRANSITION_INVALIDE',
              message: payload.messageErreur ?? "Transition d'état invalide.",
              horodatage: new Date().toISOString(),
              chemin: `/ae/${this.nature}/demandes-revocation`,
            };
            resolve({
              status: statusCode,
              headers: { 'Content-Type': 'application/json' },
              body: err,
            });
          }
        },
        reject: () => {},
        timer,
      });

      // Dispatch to JMS queue queue.pki.ac.<acCibleId>.demandes
      this.broker.sendToQueue(`queue.pki.ac.${acCibleId}.demandes`, {
        headers: {
          JMSCorrelationID: demandeId,
          JMSReplyTo: `queue.pki.ae.${this.id}.reponses`,
          type_message: 'DEMANDE_REVOCATION',
          action_revocation: reqBody.action,
          ae_emettrice_id: this.id,
        },
        payload: {
          demandeId,
          numeroSerieCertificat: reqBody.numeroSerieCertificat,
          sujetDemandeur: entite.nomEntite,
          action: reqBody.action,
          motif: reqBody.motif,
          aeAuthentification: {
            aeId: this.id,
            horodatageVerification: new Date().toISOString(),
            droitDemandeRevocationVerifie: true,
          },
        },
      });
    });
  }


  public enregistrerEntite(options: EnregistrerEntiteOptions): DroitsEntiteAE {
    const salt = crypto.randomBytes(16).toString('hex');
    const motDePasseHash = hashPassword(options.motDePasse, salt);
    const nature = options.natureRessource ?? this.nature;

    const entite: EntiteAERegistre = {
      nomEntite: options.nomEntite,
      natureRessource: nature,
      droitSignature: options.droitSignature ?? false,
      droitChiffrement: options.droitChiffrement ?? false,
      droitDemandeRevocation: options.droitDemandeRevocation ?? false,
      acRattachementId: options.acRattachementId,
      motDePasseHash,
      salt,
    };

    this.entites.set(options.nomEntite, entite);
    return this.toDroitsPublics(entite);
  }

  public verifierAuthentification(nomEntite: string, motDePasse: string): boolean {
    const entite = this.entites.get(nomEntite);
    if (!entite) {
      return false;
    }
    const computedHash = hashPassword(motDePasse, entite.salt);
    return computedHash === entite.motDePasseHash;
  }

  public getEntite(nomEntite: string): EntiteAERegistre | undefined {
    return this.entites.get(nomEntite);
  }

  public getDroitsEntite(nomEntite: string): DroitsEntiteAE | undefined {
    const entite = this.entites.get(nomEntite);
    if (!entite) {
      return undefined;
    }
    return this.toDroitsPublics(entite);
  }

  private toDroitsPublics(entite: EntiteAERegistre): DroitsEntiteAE {
    return {
      nomEntite: entite.nomEntite,
      natureRessource: entite.natureRessource,
      droitSignature: entite.droitSignature,
      droitChiffrement: entite.droitChiffrement,
      droitDemandeRevocation: entite.droitDemandeRevocation,
      acRattachementId: entite.acRattachementId,
    };
  }

  public async handleRequest(req: RestRequest): Promise<RestResponse> {
    const cleanPath = req.path.split('?')[0].replace(/\/+$/, '');

    // 1. GET /ae/{nature}/entites/{nomEntite}/droits
    const droitsMatch = cleanPath.match(
      new RegExp(`^/ae/${this.nature}/entites/([^/]+)/droits$`)
    );
    if (req.method === 'GET' && droitsMatch) {
      const nomEntite = decodeURIComponent(droitsMatch[1]);
      const entite = this.getEntite(nomEntite);
      if (!entite) {
        const err: ErreurApi = {
          code: 'ENTITE_INTROUVABLE',
          message: `L'entité '${nomEntite}' est introuvable auprès de l'AE '${this.id}'.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Check authentication header X-Entite-Mot-De-Passe
      const headerPassword =
        req.headers?.['X-Entite-Mot-De-Passe'] ??
        req.headers?.['x-entite-mot-de-passe'];

      if (!headerPassword || !this.verifierAuthentification(nomEntite, headerPassword)) {
        const err: ErreurApi = {
          code: 'NON_AUTHENTIFIE',
          message: `Authentification échouée pour l'entité '${nomEntite}'.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: this.toDroitsPublics(entite),
      };
    }

    // 2. POST /ae/{nature}/demandes-certification
    if (
      req.method === 'POST' &&
      cleanPath === `/ae/${this.nature}/demandes-certification`
    ) {
      const body = req.body as Partial<DemandeCertificationRequete> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        !body.nomEntite ||
        !body.motDePasse ||
        !body.usage ||
        (!body.genererBicle && !body.clePublique)
      ) {
        const err: ErreurApi = {
          code: 'REQUETE_INVALIDE',
          message:
            'Paramètres de demande de certification manquants ou invalides (nomEntite, motDePasse, usage ou clePublique requis).',
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Authenticate entity
      const entite = this.getEntite(body.nomEntite);
      if (!entite || !this.verifierAuthentification(body.nomEntite, body.motDePasse)) {
        const err: ErreurApi = {
          code: 'NON_AUTHENTIFIE',
          message: `Authentification échouée pour l'entité '${body.nomEntite}'.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Check rights against requested usage
      if (body.usage === 'CERTIFICATION_AC') {
        const err: ErreurApi = {
          code: 'DROITS_INSUFFISANTS',
          message:
            "L'usage 'CERTIFICATION_AC' est réservé aux Autorités de Certification.",
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      const requiresSignature =
        body.usage === 'SIGNATURE' || body.usage === 'SIGNATURE_ET_CHIFFREMENT';
      const requiresChiffrement =
        body.usage === 'CHIFFREMENT' || body.usage === 'SIGNATURE_ET_CHIFFREMENT';

      if (requiresSignature && !entite.droitSignature) {
        const err: ErreurApi = {
          code: 'DROITS_INSUFFISANTS',
          message: `L'entité '${body.nomEntite}' ne dispose pas du droit de signature ('droitSignature=false').`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      if (requiresChiffrement && !entite.droitChiffrement) {
        const err: ErreurApi = {
          code: 'DROITS_INSUFFISANTS',
          message: `L'entité '${body.nomEntite}' ne dispose pas du droit de chiffrement ('droitChiffrement=false').`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      return this.traiterDemandeCertification(body as DemandeCertificationRequete, entite);
    }

    // 3. GET /ae/{nature}/demandes-certification/{demandeId}
    const demandeIdMatch = cleanPath.match(
      new RegExp(`^/ae/${this.nature}/demandes-certification/([^/]+)$`)
    );
    if (req.method === 'GET' && demandeIdMatch) {
      const demandeId = decodeURIComponent(demandeIdMatch[1]);
      const demande = this.demandesParId.get(demandeId);
      if (!demande) {
        const err: ErreurApi = {
          code: 'RESSOURCE_INTROUVABLE',
          message: `La demande de certification '${demandeId}' est introuvable.`,
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
        body: demande,
      };
    }

    // 4. POST /ae/{nature}/demandes-revocation
    if (
      req.method === 'POST' &&
      cleanPath === `/ae/${this.nature}/demandes-revocation`
    ) {
      const body = req.body as Partial<DemandeRevocationRequete> | undefined;
      if (
        !body ||
        typeof body !== 'object' ||
        !body.nomEntite ||
        !body.motDePasse ||
        !body.numeroSerieCertificat ||
        !body.action ||
        !['REVOCATION', 'SUSPENSION', 'REACTIVATION'].includes(body.action)
      ) {
        const err: ErreurApi = {
          code: 'REQUETE_INVALIDE',
          message:
            'Paramètres de demande de révocation manquants ou invalides (nomEntite, motDePasse, numeroSerieCertificat, action requis).',
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Authenticate entity
      const entite = this.getEntite(body.nomEntite);
      if (!entite || !this.verifierAuthentification(body.nomEntite, body.motDePasse)) {
        const err: ErreurApi = {
          code: 'NON_AUTHENTIFIE',
          message: `Authentification échouée pour l'entité '${body.nomEntite}'.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Check droitDemandeRevocation
      if (!entite.droitDemandeRevocation) {
        const err: ErreurApi = {
          code: 'DROITS_INSUFFISANTS',
          message: `L'entité '${body.nomEntite}' ne dispose pas du droit de demande de révocation ('droitDemandeRevocation=false').`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Check certificate existence
      const cert = this.getCertificat(body.numeroSerieCertificat);
      if (!cert) {
        const err: ErreurApi = {
          code: 'CERTIFICAT_INTROUVABLE',
          message: `Le certificat avec le numéro de série '${body.numeroSerieCertificat}' est introuvable.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Check certificate ownership
      if (cert.sujet !== entite.nomEntite) {
        const err: ErreurApi = {
          code: 'DROITS_INSUFFISANTS',
          message: `L'entité '${body.nomEntite}' n'est pas le Porteur (Sujet) du certificat '${body.numeroSerieCertificat}'.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      // Check expiration
      if (new Date(cert.dateFinValidite).getTime() < Date.now()) {
        const err: ErreurApi = {
          code: 'TRANSITION_INVALIDE',
          message: "Impossible d'opérer sur un certificat expiré.",
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 409,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }

      return this.traiterDemandeRevocation(body as DemandeRevocationRequete, entite, cert);
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

export class ServiceAutoriteEnregistrement {
  private instances = new Map<NatureRessource, AutoriteEnregistrement>();

  constructor(public readonly broker: InMemoryJmsBroker) {}

  public enregistrerAe(ae: AutoriteEnregistrement): void {
    this.instances.set(ae.nature, ae);
  }

  public getAeParNature(nature: NatureRessource): AutoriteEnregistrement {
    const ae = this.instances.get(nature);
    if (!ae) {
      throw new Error(`Aucune Autorité d'Enregistrement configurée pour la nature '${nature}'.`);
    }
    return ae;
  }

  public async handleRequest(req: RestRequest): Promise<RestResponse> {
    const cleanPath = req.path.split('?')[0].replace(/\/+$/, '');
    const match = cleanPath.match(/^\/ae\/([^/]+)(\/.*)?$/);
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
    const ae = this.instances.get(natureStr);
    if (!ae) {
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

    return ae.handleRequest(req);
  }
}

export function bootstrapAutoritesEnregistrement(
  broker: InMemoryJmsBroker,
  annuaire?: ServicePublication
): ServiceAutoriteEnregistrement {
  const service = new ServiceAutoriteEnregistrement(broker);

  const natures: NatureRessource[] = ['messagerie', 'routeurs', 'services', 'utilisateurs'];
  for (const nature of natures) {
    const ae = new AutoriteEnregistrement({
      id: `AE-${nature.toUpperCase()}`,
      nature,
      broker,
      annuaire,
    });
    service.enregistrerAe(ae);
  }

  return service;
}
