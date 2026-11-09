import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import { bootstrapHierarchieAc, AutoriteCertification } from '../src/ac/index.js';
import { ServicePublication } from '../src/annuaire/index.js';
import {
  AutoriteEnregistrement,
  bootstrapAutoritesEnregistrement,
} from '../src/ae/index.js';
import {
  AutoriteValidation,
  bootstrapAutoritesValidation,
} from '../src/av/index.js';
import {
  ServiceDiscoveryRegistry,
  ConfigurationServer,
  ApiGateway,
  MessagingEdgeGateway,
  AclForbiddenDestinationError,
  bootstrapEdgeEnvironment,
} from '../src/edge/index.js';
import { CorrespondantClient } from '../src/chat/index.js';
import { generateRsaKeyPair } from '../src/crypto/index.js';
import type {
  ErreurApi,
  DemandeCertificationReponse,
  ValidationCertificatReponse,
} from '../src/types/index.js';

describe('Ticket #8: Couche Micro-services « Edge »', () => {
  let broker: InMemoryJmsBroker;

  beforeEach(() => {
    broker = new InMemoryJmsBroker();
  });

  describe('1. API Gateway & Dynamic Routing (/ae, /av, /annuaire)', () => {
    it('should dynamically route /ae/{nature}/... to the matching AE instance', async () => {
      const env = bootstrapEdgeEnvironment(broker);
      const aeMessagerie = env.discovery.getAe('messagerie')!;

      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice@organisation.fr',
        motDePasse: 'Secret123!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const res = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/ae/messagerie/entites/alice@organisation.fr/droits',
        headers: {
          'X-Entite-Mot-De-Passe': 'Secret123!',
        },
      });

      expect(res.status).toBe(200);
      expect((res.body as any).nomEntite).toBe('alice@organisation.fr');
      expect((res.body as any).natureRessource).toBe('messagerie');
    });

    it('should dynamically route /av/{nature}/... to the matching AV instance', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      const res = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/av/messagerie/certificats/SN-UNKNOWN-999/statut',
      });

      expect(res.status).toBe(200);
      expect((res.body as any).statut).toBe('INCONNU');
      expect((res.body as any).numeroSerie).toBe('SN-UNKNOWN-999');
    });

    it('should route /annuaire/... to ServicePublication instance', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      const res = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/annuaire/autorites',
      });

      expect(res.status).toBe(200);
      expect(Array.isArray(res.body)).toBe(true);
      expect((res.body as any[]).length).toBeGreaterThan(0);
    });

    it('should return 404 ErreurApi with code NATURE_NON_SUPPORTEE for unconfigured nature on /ae or /av', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      const resAe = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/ae/finance/entites/trader1/droits',
      });
      expect(resAe.status).toBe(404);
      expect((resAe.body as ErreurApi).code).toBe('NATURE_NON_SUPPORTEE');

      const resAv = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/av/finance/certificats/SN-123/statut',
      });
      expect(resAv.status).toBe(404);
      expect((resAv.body as ErreurApi).code).toBe('NATURE_NON_SUPPORTEE');
    });

    it('should return 404 ErreurApi with code RESSOURCE_INTROUVABLE for unknown endpoints', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      const res = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/unknown/service/endpoint',
      });
      expect(res.status).toBe(404);
      expect((res.body as ErreurApi).code).toBe('RESSOURCE_INTROUVABLE');
    });
  });

  describe('2. Dynamic Registration of New Nature Pairs at Runtime (Zero Restart)', () => {
    it('should register a new nature pair (AE, AV) at runtime and immediately route requests to them', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      // Verify 'iot' is initially unsupported
      const preCheck = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/ae/iot/entites/sensor-01/droits',
      });
      expect(preCheck.status).toBe(404);
      expect((preCheck.body as ErreurApi).code).toBe('NATURE_NON_SUPPORTEE');

      // Create new AE and AV for 'iot'
      const aeIot = new AutoriteEnregistrement({
        id: 'AE-IOT',
        nature: 'iot',
        broker,
        annuaire: env.annuaire,
      });

      const avIot = new AutoriteValidation({
        id: 'AV-IOT',
        nature: 'iot',
        broker,
        annuaire: env.annuaire,
      });

      // Register the entity in the new AE
      aeIot.enregistrerEntite({
        nomEntite: 'sensor-01.factory.organisation.fr',
        motDePasse: 'IotPass2026!',
        natureRessource: 'iot',
        droitSignature: true,
        droitChiffrement: false,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-INFRA-SERVEURS',
      });

      // Dynamically register new nature pair in ServiceDiscoveryRegistry
      env.discovery.registerNaturePair({
        nature: 'iot',
        ae: aeIot,
        av: avIot,
      });

      // Register nature in ConfigurationServer as well
      env.configServer.registerNature('iot');
      expect(env.configServer.hasNature('iot')).toBe(true);

      // Immediately test ApiGateway without any restart or redeployment
      const resAe = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/ae/iot/entites/sensor-01.factory.organisation.fr/droits',
        headers: {
          'X-Entite-Mot-De-Passe': 'IotPass2026!',
        },
      });

      expect(resAe.status).toBe(200);
      expect((resAe.body as any).nomEntite).toBe('sensor-01.factory.organisation.fr');
      expect((resAe.body as any).natureRessource).toBe('iot');

      // Test AV for 'iot' as well
      const resAv = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/av/iot/certificats/SN-IOT-TEST/statut',
      });
      expect(resAv.status).toBe(200);
      expect((resAv.body as any).statut).toBe('INCONNU');
    });

    it('should support dynamic unregistration of services from ServiceDiscoveryRegistry', async () => {
      const env = bootstrapEdgeEnvironment(broker);
      expect(env.discovery.getAe('messagerie')).toBeDefined();

      const service = env.discovery.findServices({ type: 'AE', nature: 'messagerie' })[0];
      const removed = env.discovery.unregister(service.id);
      expect(removed).toBe(true);

      const res = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/ae/messagerie/entites/alice/droits',
      });
      expect(res.status).toBe(404);
      expect((res.body as ErreurApi).code).toBe('NATURE_NON_SUPPORTEE');
    });
  });

  describe('3. Configuration Server (Centralized CA Topology, Root Anchor & REST)', () => {
    it('should store and distribute Root CA anchor and complete 3-level CA topology', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      // Verify root CA anchor
      const rootCert = env.configServer.getRootCaAnchor();
      expect(rootCert).toBeDefined();
      expect(rootCert?.sujet).toBe('AC-N1-RACINE');

      // Verify topology
      const topology = env.configServer.getCaTopology();
      expect(topology.length).toBeGreaterThanOrEqual(6);

      const n1 = topology.find((ca) => ca.niveau === 1);
      expect(n1?.acId).toBe('AC-N1-RACINE');

      const n2Dsi = topology.find((ca) => ca.acId === 'AC-N2-DSI');
      expect(n2Dsi?.acParenteId).toBe('AC-N1-RACINE');

      const n3Msg = topology.find((ca) => ca.acId === 'AC-N3-DSI-MESSAGERIE');
      expect(n3Msg?.acParenteId).toBe('AC-N2-DSI');
      expect(n3Msg?.jmsQueueDemandes).toBe('queue.pki.ac.AC-N3-DSI-MESSAGERIE.demandes');
    });

    it('should allow dynamic addition of subordinate CAs', () => {
      const env = bootstrapEdgeEnvironment(broker);

      const newSubCa = env.configServer.registerSubordinateCa('AC-N2-INFRA', {
        id: 'AC-N3-INFRA-IOT',
        nomOrganisationnel: 'Service Objets Connectés & IoT',
      });

      expect(newSubCa.niveau).toBe(3);
      expect(newSubCa.acParenteId).toBe('AC-N2-INFRA');
      expect(newSubCa.jmsQueueDemandes).toBe('queue.pki.ac.AC-N3-INFRA-IOT.demandes');

      const queried = env.configServer.getCa('AC-N3-INFRA-IOT');
      expect(queried).toEqual(newSubCa);
    });

    it('should expose Configuration Server REST endpoints through ApiGateway', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      // GET /config/racine
      const resRacine = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/config/racine',
      });
      expect(resRacine.status).toBe(200);
      expect((resRacine.body as any).sujet).toBe('AC-N1-RACINE');

      // GET /config/topologie
      const resTopo = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/config/topologie',
      });
      expect(resTopo.status).toBe(200);
      expect((resTopo.body as any[]).length).toBeGreaterThanOrEqual(6);

      // GET /config/topologie/AC-N2-DSI
      const resAc = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/config/topologie/AC-N2-DSI',
      });
      expect(resAc.status).toBe(200);
      expect((resAc.body as any).acId).toBe('AC-N2-DSI');

      // GET /config/natures & POST /config/natures
      const postNature = await env.apiGateway.handleRequest({
        method: 'POST',
        path: '/config/natures',
        body: { nature: 'smart-sensors' },
      });
      expect(postNature.status).toBe(201);

      const resNatures = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/config/natures',
      });
      expect(resNatures.status).toBe(200);
      expect((resNatures.body as string[])).toContain('smart-sensors');
    });
  });

  describe('4. Rate Limiting on Sensitive Endpoints (Enrollment & Revocation)', () => {
    it('should rate-limit POST /ae/{nature}/demandes-certification when threshold is exceeded with HTTP 429', async () => {
      const env = bootstrapEdgeEnvironment(broker);
      const aeMessagerie = env.discovery.getAe('messagerie')!;

      aeMessagerie.enregistrerEntite({
        nomEntite: 'attacker@organisation.fr',
        motDePasse: 'Password123!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: false,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Configure a strict limit of 3 requests per 60 seconds
      env.apiGateway.setRateLimitOptions({
        maxRequests: 3,
        windowMs: 60_000,
      });

      const clientIpHeaders = {
        'X-Forwarded-For': '198.51.100.42',
      };

      const makeEnrollmentRequest = () =>
        env.apiGateway.handleRequest({
          method: 'POST',
          path: '/ae/messagerie/demandes-certification',
          headers: clientIpHeaders,
          body: {
            nomEntite: 'attacker@organisation.fr',
            motDePasse: 'Password123!',
            usage: 'SIGNATURE',
            genererBicle: true,
          },
        });

      // Requests 1, 2, 3 should be permitted (status 201)
      const res1 = await makeEnrollmentRequest();
      expect(res1.status).toBe(201);

      const res2 = await makeEnrollmentRequest();
      expect(res2.status).toBe(201);

      const res3 = await makeEnrollmentRequest();
      expect(res3.status).toBe(201);

      // Request 4 must be BLOCKED with HTTP 429 Too Many Requests
      const res4 = await makeEnrollmentRequest();
      expect(res4.status).toBe(429);
      expect(res4.headers?.['Retry-After']).toBeDefined();
      expect(res4.headers?.['X-RateLimit-Remaining']).toBe('0');

      const err = res4.body as ErreurApi;
      expect(err.code).toBe('RATE_LIMIT_EXCEEDED');
      expect(err.message).toContain('rate limit');

      // Non-sensitive endpoints should NOT be blocked for this client
      const resNonSensitive = await env.apiGateway.handleRequest({
        method: 'GET',
        path: '/ae/messagerie/entites/attacker@organisation.fr/droits',
        headers: {
          ...clientIpHeaders,
          'X-Entite-Mot-De-Passe': 'Password123!',
        },
      });
      expect(resNonSensitive.status).toBe(200);

      // Another client IP should not be blocked
      const resOtherClient = await env.apiGateway.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        headers: { 'X-Forwarded-For': '203.0.113.88' },
        body: {
          nomEntite: 'attacker@organisation.fr',
          motDePasse: 'Password123!',
          usage: 'SIGNATURE',
          genererBicle: true,
        },
      });
      expect(resOtherClient.status).toBe(201);
    });

    it('should rate-limit POST /ae/{nature}/demandes-revocation', async () => {
      const env = bootstrapEdgeEnvironment(broker);

      env.apiGateway.setRateLimitOptions({
        maxRequests: 2,
        windowMs: 60_000,
      });

      const clientHeaders = { 'X-Client-Id': 'client-revoker-1' };

      const makeRevokeRequest = () =>
        env.apiGateway.handleRequest({
          method: 'POST',
          path: '/ae/messagerie/demandes-revocation',
          headers: clientHeaders,
          body: {
            nomEntite: 'unknown',
            motDePasse: 'wrong',
            numeroSerieCertificat: 'SN-NONE',
            action: 'REVOCATION',
          },
        });

      // 1st request -> passes rate limit (returns 401 unauthenticated)
      const res1 = await makeRevokeRequest();
      expect(res1.status).toBe(401);

      // 2nd request -> passes rate limit
      const res2 = await makeRevokeRequest();
      expect(res2.status).toBe(401);

      // 3rd request -> BLOCKED with 429
      const res3 = await makeRevokeRequest();
      expect(res3.status).toBe(429);
      expect((res3.body as ErreurApi).code).toBe('RATE_LIMIT_EXCEEDED');
    });
  });

  describe('5. Messaging Edge Gateway (WebSocket/STOMP to JMS Firewall & ACL Security)', () => {
    it('should permit chat messaging on queue.chat.inbox.* for external participants', () => {
      const env = bootstrapEdgeEnvironment(broker);
      const aliceBridge = env.messagingGateway.createClientBridge('alice');
      const bobBridge = env.messagingGateway.createClientBridge('bob');

      let receivedMessage: any = null;
      bobBridge.registerQueueConsumer('queue.chat.inbox.bob', (msg) => {
        receivedMessage = msg;
      });

      aliceBridge.sendToQueue('queue.chat.inbox.bob', {
        headers: { echange_id: 'ech-1', type_message: 'INIT_ECHANGE', niveau_securite: 'NON_SECURISE' },
        payload: { text: 'Hello Bob!' },
      });

      expect(receivedMessage).toBeDefined();
      expect(receivedMessage.payload.text).toBe('Hello Bob!');
    });

    it('should strictly BLOCK external clients from publishing to internal PKI topics with AclForbiddenDestinationError', () => {
      const env = bootstrapEdgeEnvironment(broker);
      const bridge = env.messagingGateway.createClientBridge('malicious-client');

      // Attempting to publish forged certificate on internal PKI topic
      expect(() => {
        bridge.publish('topic.pki.publications.certificats', {
          payload: { forged: true },
        });
      }).toThrowError(AclForbiddenDestinationError);

      // Attempting to publish forged LCR on internal PKI topic
      expect(() => {
        bridge.publish('topic.pki.publications.lcr', {
          payload: { forged: true },
        });
      }).toThrowError(AclForbiddenDestinationError);
    });

    it('should strictly BLOCK external clients from sending messages to internal PKI queues', () => {
      const env = bootstrapEdgeEnvironment(broker);
      const bridge = env.messagingGateway.createClientBridge('malicious-client');

      // Attempting to inject request into AC queue
      expect(() => {
        bridge.sendToQueue('queue.pki.ac.AC-N1-RACINE.demandes', {
          payload: { bypassAe: true },
        });
      }).toThrowError(AclForbiddenDestinationError);

      // Attempting to inject into AE response queue
      expect(() => {
        bridge.sendToQueue('queue.pki.ae.AE-MESSAGERIE.reponses', {
          payload: { fakeReply: true },
        });
      }).toThrowError(AclForbiddenDestinationError);
    });

    it('should strictly BLOCK external clients from subscribing to internal PKI topics or queues', () => {
      const env = bootstrapEdgeEnvironment(broker);
      const bridge = env.messagingGateway.createClientBridge('eavesdropper');

      expect(() => {
        bridge.subscribe('topic.pki.publications.certificats', () => {});
      }).toThrowError(AclForbiddenDestinationError);

      expect(() => {
        bridge.registerQueueConsumer('queue.pki.ac.AC-N2-DSI.demandes', () => {});
      }).toThrowError(AclForbiddenDestinationError);
    });

    it('should isolate inboxes and prevent client from listening to another user inbox', () => {
      const env = bootstrapEdgeEnvironment(broker);
      const eveBridge = env.messagingGateway.createClientBridge('eve');

      expect(() => {
        eveBridge.registerQueueConsumer('queue.chat.inbox.alice', () => {});
      }).toThrowError(AclForbiddenDestinationError);
    });

    it('should enable full end-to-end CorrespondantClient chat sessions across the Messaging Edge Gateway', async () => {
      const env = bootstrapEdgeEnvironment(broker);
      const ae = env.discovery.getAe('messagerie')!;

      // Enlist Alice and Bob with key pairs
      const aliceKeys = generateRsaKeyPair();
      const bobKeys = generateRsaKeyPair();

      ae.enregistrerEntite({
        nomEntite: 'alice@organisation.fr',
        motDePasse: 'AlicePass!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      ae.enregistrerEntite({
        nomEntite: 'bob@organisation.fr',
        motDePasse: 'BobPass!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Request certificates via ApiGateway
      const aliceCertRes = await env.apiGateway.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice@organisation.fr',
          motDePasse: 'AlicePass!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: aliceKeys.publicKeyBase64,
        },
      });
      const aliceCert = (aliceCertRes.body as DemandeCertificationReponse).certificat!;

      const bobCertRes = await env.apiGateway.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'bob@organisation.fr',
          motDePasse: 'BobPass!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: bobKeys.publicKeyBase64,
        },
      });
      const bobCert = (bobCertRes.body as DemandeCertificationReponse).certificat!;

      // Create CorrespondantClients backed by MessagingEdgeGateway client bridges!
      const aliceChat = new CorrespondantClient({
        id: 'alice@organisation.fr',
        broker: env.messagingGateway.createClientBridge('alice@organisation.fr'),
        certificatNumeroSerie: aliceCert.numeroSerie,
        clePriveePem: aliceKeys.privateKeyPem,
        clePubliquePem: aliceKeys.publicKeyPem,
        annuaire: env.annuaire,
        av: env.discovery.getAv('messagerie')!,
      });

      const bobChat = new CorrespondantClient({
        id: 'bob@organisation.fr',
        broker: env.messagingGateway.createClientBridge('bob@organisation.fr'),
        certificatNumeroSerie: bobCert.numeroSerie,
        clePriveePem: bobKeys.privateKeyPem,
        clePubliquePem: bobKeys.publicKeyPem,
        annuaire: env.annuaire,
        av: env.discovery.getAv('messagerie')!,
      });

      let bobReceivedText = '';
      bobChat.onMessage((msg) => {
        bobReceivedText = msg.texte;
      });

      // Alice initiates a signed exchange to Bob via Edge Gateway
      const session = aliceChat.initialiserEchange('bob@organisation.fr', {
        niveauSecurite: 'SIGNE',
        premierMessage: 'Hello through Edge Gateway!',
      });
      expect(session.etat).toBe('ACTIF');
      expect(bobReceivedText).toBe('Hello through Edge Gateway!');
    });

    it('should strictly BLOCK external chat topics and non-inbox queues (multi-party group chat out of scope)', () => {
      const env = bootstrapEdgeEnvironment(broker);
      const bridge = env.messagingGateway.createClientBridge('alice@organisation.fr');

      // Attempting to subscribe to chat topics
      expect(() => {
        bridge.subscribe('topic.chat.general', () => {});
      }).toThrowError(AclForbiddenDestinationError);

      expect(() => {
        bridge.subscribe('topic.chat.salons.direction', () => {});
      }).toThrowError(AclForbiddenDestinationError);

      // Attempting to publish or send to chat topics
      expect(() => {
        bridge.publish('topic.chat.general', {
          headers: {},
          payload: { text: 'spam' },
        });
      }).toThrowError(AclForbiddenDestinationError);

      // Attempting to send to a non-inbox chat queue
      expect(() => {
        bridge.sendToQueue('queue.chat.broadcast', {
          headers: {},
          payload: { text: 'spam' },
        });
      }).toThrowError(AclForbiddenDestinationError);
    });

  });

    describe('6. TLS Enforcement on API Gateway (enforceTls)', () => {
      it('should enforce TLS when enforceTls is enabled and reject non-https requests with 403 TLS_REQUIS', async () => {
        const env = bootstrapEdgeEnvironment({ broker, enforceTls: true });

        // Request with missing X-Forwarded-Proto
        const resMissing = await env.apiGateway.handleRequest({
          method: 'GET',
          path: '/annuaire/autorites',
        });
        expect(resMissing.status).toBe(403);
        const errMissing = resMissing.body as ErreurApi;
        expect(errMissing.code).toBe('TLS_REQUIS');

        // Request with http X-Forwarded-Proto
        const resHttp = await env.apiGateway.handleRequest({
          method: 'GET',
          path: '/annuaire/autorites',
          headers: {
            'X-Forwarded-Proto': 'http',
          },
        });
        expect(resHttp.status).toBe(403);
        const errHttp = resHttp.body as ErreurApi;
        expect(errHttp.code).toBe('TLS_REQUIS');

        // Request with https X-Forwarded-Proto
        const resHttps = await env.apiGateway.handleRequest({
          method: 'GET',
          path: '/annuaire/autorites',
          headers: {
            'X-Forwarded-Proto': 'https',
          },
        });
        expect(resHttps.status).toBe(200);
      });

      it('should allow requests without TLS when enforceTls is disabled by default', async () => {
        const env = bootstrapEdgeEnvironment({ broker, enforceTls: false });
        const res = await env.apiGateway.handleRequest({
          method: 'GET',
          path: '/annuaire/autorites',
        });
        expect(res.status).toBe(200);
      });
    });

});
