import { describe, it, expect } from 'vitest';
import {
  InMemoryAmqpBroker,
  AMQP_EXCHANGES,
  amorcerHierarchieAc,
  AutoriteEnregistrement,
  AutoriteValidation,
  ServicePublication,
  ServiceDiscovery,
  ConfigurationServer,
  RateLimiter,
  ApiGateway,
  PasserelleEdgeMessagerie,
  ErreurAclEdge,
  generateRsaKeyPair
} from '../src/index.js';
import type {
  Certificat,
  DemandeCertificationReponse,
  EnveloppeChatAmqp,
  ErreurApi
} from '../src/index.js';

describe('Slice 1 — ServiceDiscovery : registre dynamique AE, AV et ServicePublication', () => {
  it('enregistre et résout AE, AV et ServicePublication, et supporte l’ajout à chaud d’une nouvelle nature', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const aeMessagerie = new AutoriteEnregistrement({ nature: 'messagerie', broker });
    await aeMessagerie.ready();
    const avMessagerie = new AutoriteValidation({ nature: 'messagerie', broker });
    await avMessagerie.ready();

    const discovery = new ServiceDiscovery();
    discovery.enregistrerAnnuaire(annuaire);
    discovery.enregistrerAe('messagerie', aeMessagerie);
    discovery.enregistrerAv('messagerie', avMessagerie);

    expect(discovery.resoudreAnnuaire()).toBe(annuaire);
    expect(discovery.resoudreAe('messagerie')).toBe(aeMessagerie);
    expect(discovery.resoudreAv('messagerie')).toBe(avMessagerie);
    expect(discovery.resoudreAe('iot')).toBeUndefined();
    expect(discovery.resoudreAv('iot')).toBeUndefined();

    // Ajout à chaud d'une nouvelle nature "iot"
    const aeIot = new AutoriteEnregistrement({ nature: 'iot', broker });
    await aeIot.ready();
    const avIot = new AutoriteValidation({ nature: 'iot', broker });
    await avIot.ready();

    discovery.enregistrerNature('iot', { ae: aeIot, av: avIot });

    expect(discovery.resoudreAe('iot')).toBe(aeIot);
    expect(discovery.resoudreAv('iot')).toBe(avIot);
    expect(discovery.listerNatures()).toEqual(expect.arrayContaining(['messagerie', 'iot']));

    await aeMessagerie.arreter();
    await avMessagerie.arreter();
    await aeIot.arreter();
    await avIot.arreter();
    await annuaire.arreter();
  });
});

describe('Slice 2 — ConfigurationServer : topologie AC, ancre racine et paramètres AMQP', () => {
  it('sert /config/topologie-ac (niveaux 1-2-3), /config/ancre-racine (AC Racine auto-signée) et /config/amqp, et rejette 404/405', async () => {
    const broker = new InMemoryAmqpBroker();
    const hierarchie = await amorcerHierarchieAc(broker);
    const configServer = new ConfigurationServer({ hierarchie });

    const repTopo = configServer.handleRestRequest({
      method: 'GET',
      path: '/config/topologie-ac'
    });
    expect(repTopo.status).toBe(200);
    const topo = repTopo.body as {
      acRacineId: string;
      profondeur: number;
      autorites: Array<{ acId: string; niveau: number; acParenteId: string | null }>;
      niveaux: {
        niveau1: Array<{ acId: string }>;
        niveau2: Array<{ acId: string }>;
        niveau3: Array<{ acId: string }>;
      };
    };
    expect(topo.acRacineId).toBe('AC-N1-RACINE');
    expect(topo.profondeur).toBe(3);
    expect(topo.autorites.map((a) => a.acId)).toEqual(
      expect.arrayContaining([
        'AC-N1-RACINE',
        'AC-N2-DSI',
        'AC-N2-INFRA',
        'AC-N3-DSI-MESSAGERIE',
        'AC-N3-INFRA-RESEAU'
      ])
    );
    expect(topo.niveaux.niveau1.map((a) => a.acId)).toEqual(['AC-N1-RACINE']);
    expect(topo.niveaux.niveau2.map((a) => a.acId).sort()).toEqual([
      'AC-N2-DSI',
      'AC-N2-INFRA'
    ]);
    expect(topo.niveaux.niveau3.map((a) => a.acId).sort()).toEqual([
      'AC-N3-DSI-MESSAGERIE',
      'AC-N3-INFRA-RESEAU'
    ]);

    const repAncre = configServer.handleRestRequest({
      method: 'GET',
      path: '/api/v1/config/ancre-racine'
    });
    expect(repAncre.status).toBe(200);
    const ancre = repAncre.body as Certificat;
    expect(ancre.sujet).toBe('AC-N1-RACINE');
    expect(ancre.identifiantAcEmettrice).toBe('AC-N1-RACINE');
    expect(ancre.usage).toBe('CERTIFICATION_AC');
    expect(ancre.numeroSerie).toBe(hierarchie.racine.getCertificatAc().numeroSerie);

    const repAmqp = configServer.handleRestRequest({
      method: 'GET',
      path: '/config/amqp'
    });
    expect(repAmqp.status).toBe(200);
    const amqp = repAmqp.body as {
      echanges: {
        commandes: { nom: string; type: string; durable: boolean };
        publications: { nom: string; type: string; durable: boolean };
        chatMessages: { nom: string; type: string; durable: boolean };
      };
    };
    expect(amqp.echanges.commandes).toEqual({
      nom: AMQP_EXCHANGES.COMMANDES,
      type: 'direct',
      durable: true
    });
    expect(amqp.echanges.publications).toEqual({
      nom: AMQP_EXCHANGES.PUBLICATIONS,
      type: 'topic',
      durable: true
    });
    expect(amqp.echanges.chatMessages).toEqual({
      nom: AMQP_EXCHANGES.CHAT_MESSAGES,
      type: 'direct',
      durable: true
    });

    const repPost = configServer.handleRestRequest({
      method: 'POST',
      path: '/config/amqp'
    });
    expect(repPost.status).toBe(405);
    expect((repPost.body as ErreurApi).code).toBe('METHODE_NON_AUTORISEE');

    const rep404 = configServer.handleRestRequest({
      method: 'GET',
      path: '/config/inconnu'
    });
    expect(rep404.status).toBe(404);

    hierarchie.services.dsiMessagerie.suspendreConsommation();
    hierarchie.services.infraReseau.suspendreConsommation();
  });
});

describe('Slice 3 — RateLimiter : limitation de débit par fenêtre glissante', () => {
  it('autorise jusqu’à la limite configurée, bloque au-delà et rétablit après expiration de la fenêtre', () => {
    let maintenantMs = 1_000_000;
    const limiter = new RateLimiter({
      limiteRequetes: 3,
      fenetreMs: 10_000,
      horloge: () => new Date(maintenantMs)
    });

    const r1 = limiter.verifierEtConsommer('client-1:/ae/messagerie/demandes-certification');
    const r2 = limiter.verifierEtConsommer('client-1:/ae/messagerie/demandes-certification');
    const r3 = limiter.verifierEtConsommer('client-1:/ae/messagerie/demandes-certification');
    const r4 = limiter.verifierEtConsommer('client-1:/ae/messagerie/demandes-certification');

    expect(r1).toMatchObject({ autorise: true, restant: 2, limite: 3 });
    expect(r2).toMatchObject({ autorise: true, restant: 1, limite: 3 });
    expect(r3).toMatchObject({ autorise: true, restant: 0, limite: 3 });
    expect(r4.autorise).toBe(false);
    expect(r4.restant).toBe(0);

    // Une autre clé reste indépendante
    const rAutre = limiter.verifierEtConsommer('client-2:/ae/messagerie/demandes-certification');
    expect(rAutre).toMatchObject({ autorise: true, restant: 2, limite: 3 });

    // Avancer le temps au-delà de la fenêtre glissante
    maintenantMs += 10_001;
    const rApres = limiter.verifierEtConsommer('client-1:/ae/messagerie/demandes-certification');
    expect(rApres).toMatchObject({ autorise: true, restant: 2, limite: 3 });
  });
});

describe('Slice 4 — ApiGateway : routage dynamique, TLS, rate-limiting 429 et cache X-Cache', () => {
  it('route /ae, /av, /annuaire, /config avec/sans /api/v1, applique TLS (403), rate-limiting (429), cache (MISS/HIT) et ajout à chaud', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();
    const avMsg = new AutoriteValidation({ nature: 'messagerie', broker });
    await avMsg.ready();
    const hierarchie = await amorcerHierarchieAc(broker);

    const aeMsg = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice@dsi.org',
          motDePasse: 'pass-alice',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await aeMsg.ready();

    const discovery = new ServiceDiscovery();
    discovery.enregistrerAnnuaire(annuaire);
    discovery.enregistrerNature('messagerie', { ae: aeMsg, av: avMsg });

    const configServer = new ConfigurationServer({ hierarchie });
    const rateLimiter = new RateLimiter({ limiteRequetes: 2, fenetreMs: 60_000 });
    const gateway = new ApiGateway({
      serviceDiscovery: discovery,
      configurationServer: configServer,
      exigerTls: true,
      rateLimiter
    });

    // 1. Rejet TLS 403 sans x-forwarded-proto: https
    const repNoTls = await gateway.handleRequest({
      method: 'GET',
      path: '/config/ancre-racine'
    });
    expect(repNoTls.status).toBe(403);
    expect((repNoTls.body as ErreurApi).code).toBe('TLS_REQUIS');

    const httpsHeaders = { 'x-forwarded-proto': 'https' };

    // 2. Cache MISS puis HIT sur /config/ancre-racine
    const repAncre1 = await gateway.handleRequest({
      method: 'GET',
      path: '/api/v1/config/ancre-racine',
      headers: httpsHeaders
    });
    expect(repAncre1.status).toBe(200);
    expect(repAncre1.headers?.['X-Cache']).toBe('MISS');

    const repAncre2 = await gateway.handleRequest({
      method: 'GET',
      path: '/config/ancre-racine',
      headers: httpsHeaders
    });
    expect(repAncre2.status).toBe(200);
    expect(repAncre2.headers?.['X-Cache']).toBe('HIT');

    // 3. Enrôlement via ApiGateway (1er et 2e appels autorisés, 3e bloqué en 429)
    const kp = generateRsaKeyPair();
    const repCert1 = await gateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-certification',
      headers: httpsHeaders,
      body: {
        nomEntite: 'alice@dsi.org',
        motDePasse: 'pass-alice',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: kp.publicKeyPem
      }
    });
    expect(repCert1.status).toBe(201);
    const certAlice = (repCert1.body as DemandeCertificationReponse).certificat!;

    const repCert2 = await gateway.handleRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      headers: httpsHeaders,
      body: {
        nomEntite: 'alice@dsi.org',
        motDePasse: 'pass-alice',
        usage: 'SIGNATURE',
        genererBicle: true
      }
    });
    expect(repCert2.status).toBe(201);

    const repCert3 = await gateway.handleRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      headers: httpsHeaders,
      body: {
        nomEntite: 'alice@dsi.org',
        motDePasse: 'pass-alice',
        usage: 'SIGNATURE',
        genererBicle: true
      }
    });
    expect(repCert3.status).toBe(429);
    expect((repCert3.body as ErreurApi).code).toBe('TROP_DE_REQUETES');

    // 4. Cache MISS puis HIT sur /annuaire/certificats/{serial}/chemin-certification
    const repChemin1 = await gateway.handleRequest({
      method: 'GET',
      path: `/annuaire/certificats/${certAlice.numeroSerie}/chemin-certification`,
      headers: httpsHeaders
    });
    expect(repChemin1.status).toBe(200);
    expect(repChemin1.headers?.['X-Cache']).toBe('MISS');

    const repChemin2 = await gateway.handleRequest({
      method: 'GET',
      path: `/api/v1/annuaire/certificats/${certAlice.numeroSerie}/chemin-certification`,
      headers: httpsHeaders
    });
    expect(repChemin2.status).toBe(200);
    expect(repChemin2.headers?.['X-Cache']).toBe('HIT');

    // 5. Ajout à chaud d'une nouvelle nature "iot" dans ServiceDiscovery -> routable sans redémarrer ApiGateway
    const avIot = new AutoriteValidation({ nature: 'iot', broker });
    await avIot.ready();
    const aeIot = new AutoriteEnregistrement({
      nature: 'iot',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'capteur-01@infra.org',
          motDePasse: 'iot-secret',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-INFRA-RESEAU'
        }
      ]
    });
    await aeIot.ready();
    discovery.enregistrerNature('iot', { ae: aeIot, av: avIot });

    const repIotCert = await gateway.handleRequest({
      method: 'POST',
      path: '/ae/iot/demandes-certification',
      headers: httpsHeaders,
      body: {
        nomEntite: 'capteur-01@infra.org',
        motDePasse: 'iot-secret',
        usage: 'SIGNATURE',
        genererBicle: true
      }
    });
    expect(repIotCert.status).toBe(201);
    const certIot = (repIotCert.body as DemandeCertificationReponse).certificat!;

    const repIotAv = await gateway.handleRequest({
      method: 'GET',
      path: `/av/iot/certificats/${certIot.numeroSerie}/statut`,
      headers: httpsHeaders
    });
    expect(repIotAv.status).toBe(200);
    expect((repIotAv.body as { statut: string }).statut).toBe('VALIDE');

    await aeMsg.arreter();
    await avMsg.arreter();
    await aeIot.arreter();
    await avIot.arreter();
    await annuaire.arreter();
    hierarchie.services.dsiMessagerie.suspendreConsommation();
    hierarchie.services.infraReseau.suspendreConsommation();
  });
});

describe('Slice 5 — PasserelleEdgeMessagerie : cloisonnement ACL/vhost AMQP strict', () => {
  it('autorise la messagerie légitime sur ex.chat.messages et q.chat.inbox.<id>, et rejette en ErreurAclEdge tout accès PKI, tiers ou sans en-têtes requis', async () => {
    const broker = new InMemoryAmqpBroker();
    broker.declareExchange(AMQP_EXCHANGES.COMMANDES, 'direct', { durable: true });
    broker.declareExchange(AMQP_EXCHANGES.PUBLICATIONS, 'topic', { durable: true });
    broker.declareQueue('q.pki.ac.AC-N3-DSI-MESSAGERIE.demandes', { durable: true });
    broker.declareQueue('q.pki.publication.flux', { durable: true });

    const passerelle = new PasserelleEdgeMessagerie(broker);
    const transportAlice = passerelle.creerTransportPourCorrespondant('alice');
    const transportBob = passerelle.creerTransportPourCorrespondant('bob');

    const recusBob: EnveloppeChatAmqp[] = [];
    const tagBob = await transportBob.abonnerBoiteReception('bob', (env) => {
      recusBob.push(env);
    });
    expect(tagBob).toBeTruthy();

    await transportAlice.publierMessageChat(
      'bob',
      {
        echangeId: 'ech-1',
        numeroSequence: 1,
        typeMessage: 'INIT_ECHANGE',
        niveauSecurite: 'NON_SECURISE',
        emetteurId: 'alice',
        destinataireId: 'bob',
        horodatage: new Date().toISOString(),
        contenu: 'Salut Bob'
      },
      {
        correlation_id: 'ech-1',
        type: 'INIT_ECHANGE',
        headers: {
          echange_id: 'ech-1',
          type_message: 'INIT_ECHANGE',
          niveau_securite: 'NON_SECURISE',
          emetteur_id: 'alice'
        }
      }
    );

    expect(recusBob).toHaveLength(1);
    expect(recusBob[0]?.payload.contenu).toBe('Salut Bob');

    // Tentative de consommation de la file d'un tiers via ChatAmqpTransport
    await expect(
      transportAlice.abonnerBoiteReception('bob', () => {})
    ).rejects.toThrow(ErreurAclEdge);

    // Tentatives directes de publication interdites
    await expect(
      passerelle.publier('alice', AMQP_EXCHANGES.COMMANDES, 'ac.AC-N3-DSI-MESSAGERIE', { foo: 1 }, {
        headers: {
          echange_id: 'ech-1',
          type_message: 'MSG_TEXTE',
          niveau_securite: 'NON_SECURISE'
        }
      })
    ).rejects.toThrow(ErreurAclEdge);

    await expect(
      passerelle.publier('alice', AMQP_EXCHANGES.PUBLICATIONS, 'certificat.n3.messagerie', { foo: 1 }, {
        headers: {
          echange_id: 'ech-1',
          type_message: 'MSG_TEXTE',
          niveau_securite: 'NON_SECURISE'
        }
      })
    ).rejects.toThrow(ErreurAclEdge);

    // Clé de routage non conforme à inbox.<id>
    await expect(
      passerelle.publier('alice', AMQP_EXCHANGES.CHAT_MESSAGES, 'ac.AC-N3-DSI-MESSAGERIE', { foo: 1 }, {
        headers: {
          echange_id: 'ech-1',
          type_message: 'MSG_TEXTE',
          niveau_securite: 'NON_SECURISE'
        }
      })
    ).rejects.toThrow(ErreurAclEdge);

    // En-têtes protocolaires manquants
    await expect(
      passerelle.publier('alice', AMQP_EXCHANGES.CHAT_MESSAGES, 'inbox.bob', { foo: 1 }, {
        headers: {
          echange_id: 'ech-1'
        }
      })
    ).rejects.toThrow(ErreurAclEdge);

    // Tentatives de consommation interdites (files PKI ou boîte d'un tiers)
    await expect(
      passerelle.consommer('alice', 'q.pki.ac.AC-N3-DSI-MESSAGERIE.demandes', () => {})
    ).rejects.toThrow(ErreurAclEdge);

    await expect(
      passerelle.consommer('alice', 'q.pki.publication.flux', () => {})
    ).rejects.toThrow(ErreurAclEdge);

    await expect(
      passerelle.consommer('alice', 'q.chat.inbox.bob', () => {})
    ).rejects.toThrow(ErreurAclEdge);
  });
});
