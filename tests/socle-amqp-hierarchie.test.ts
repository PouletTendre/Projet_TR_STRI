import { describe, it, expect } from 'vitest';
import {
  InMemoryAmqpBroker,
  AMQP_EXCHANGES,
  matchTopicRoutingKey
} from '../src/amqp/index.js';
import {
  generateRsaKeyPair,
  publicKeyPemToBase64,
  publicKeyBase64ToPem,
  signCertificat,
  verifyCertificatSignature,
  signLcr,
  verifyLcrSignature,
  hashPassword,
  verifyPassword,
  signMessageText,
  verifyMessageSignature,
  encryptHybridMessage,
  decryptHybridMessage
} from '../src/crypto/index.js';
import {
  amorcerHierarchieAc,
  GenerateurNumeroSerie
} from '../src/ac/index.js';
import { ServicePublication } from '../src/annuaire/index.js';
import type {
  AmqpMessage,
  AutoriteCertificationInfo,
  Certificat,
  CheminCertificationReponse,
  ErreurApi,
  ListeCertificatsRevoques,
  PublicationCertificatPayload
} from '../src/types/index.js';

describe('Slice 1 — Socle AMQP 0-9-1 en mémoire (InMemoryAmqpBroker)', () => {
  it('supporte la déclaration idempotente d’échangeurs direct/topic, rejette les conflits de type et route avec jokers * et # sans doublon par file', async () => {
    const broker = new InMemoryAmqpBroker();

    broker.declareExchange(AMQP_EXCHANGES.COMMANDES, 'direct', { durable: true });
    broker.declareExchange(AMQP_EXCHANGES.COMMANDES, 'direct', { durable: true });
    expect(() =>
      broker.declareExchange(AMQP_EXCHANGES.COMMANDES, 'topic', { durable: true })
    ).toThrow();

    broker.declareExchange(AMQP_EXCHANGES.PUBLICATIONS, 'topic', { durable: true });
    broker.declareExchange(AMQP_EXCHANGES.CHAT_MESSAGES, 'direct', { durable: true });

    broker.declareQueue('q.test.topic.single', { durable: true });
    broker.declareQueue('q.test.topic.all', { durable: true });
    broker.declareQueue('q.test.direct', { durable: true });

    // Deux bindings qui matchent la même clé doivent délivrer un seul message à q.test.topic.single
    broker.bindQueue('q.test.topic.single', AMQP_EXCHANGES.PUBLICATIONS, 'certificat.*.ac');
    broker.bindQueue('q.test.topic.single', AMQP_EXCHANGES.PUBLICATIONS, 'certificat.n1.#');
    broker.bindQueue('q.test.topic.all', AMQP_EXCHANGES.PUBLICATIONS, '#');
    broker.bindQueue('q.test.direct', AMQP_EXCHANGES.COMMANDES, 'ac.n3.dsi');

    expect(matchTopicRoutingKey('certificat.*.ac', 'certificat.n2.ac')).toBe(true);
    expect(matchTopicRoutingKey('certificat.*.ac', 'certificat.n2.dsi.ac')).toBe(false);
    expect(matchTopicRoutingKey('lcr.#', 'lcr')).toBe(true);
    expect(matchTopicRoutingKey('lcr.#', 'lcr.n3.dsi')).toBe(true);
    expect(matchTopicRoutingKey('#', 'a.b.c')).toBe(true);

    const recuSingle: AmqpMessage[] = [];
    const recuAll: AmqpMessage[] = [];
    const recuDirect: AmqpMessage[] = [];

    await broker.consume('q.test.topic.single', (msg) => {
      recuSingle.push(msg);
    });
    await broker.consume('q.test.topic.all', (msg) => {
      recuAll.push(msg);
    });
    await broker.consume('q.test.direct', (msg) => {
      recuDirect.push(msg);
    });

    await broker.publish(AMQP_EXCHANGES.PUBLICATIONS, 'certificat.n1.ac', { seq: 1 });
    await broker.publish(AMQP_EXCHANGES.PUBLICATIONS, 'lcr.n3.dsi', { seq: 2 });
    await broker.publish(AMQP_EXCHANGES.COMMANDES, 'ac.n3.dsi', { cmd: 'ping' });
    await broker.publish(AMQP_EXCHANGES.COMMANDES, 'ac.n3.autre', { cmd: 'ignored' });

    expect(recuSingle).toHaveLength(1);
    expect(recuSingle[0]?.payload).toEqual({ seq: 1 });
    expect(recuAll).toHaveLength(2);
    expect(recuDirect).toHaveLength(1);
    expect(recuDirect[0]?.payload).toEqual({ cmd: 'ping' });

    expect(broker.listExchanges().map((e) => e.name)).toContain(AMQP_EXCHANGES.PUBLICATIONS);
    expect(broker.listQueues().map((q) => q.name)).toContain('q.test.direct');
    expect(broker.listBindings().length).toBeGreaterThanOrEqual(4);
  });

  it('met en file en FIFO en absence de consommateur, draine dans l’ordre à consume, applique les propriétés AMQP standard et sérialise de manière immuable', async () => {
    const broker = new InMemoryAmqpBroker();
    broker.declareExchange(AMQP_EXCHANGES.COMMANDES, 'direct', { durable: true });
    broker.declareQueue('q.fifo', { durable: true });
    broker.bindQueue('q.fifo', AMQP_EXCHANGES.COMMANDES, 'cle.fifo');

    const payloadMutable = { ordre: 1, nested: { valeur: 'initiale' } };
    await broker.publish(AMQP_EXCHANGES.COMMANDES, 'cle.fifo', payloadMutable, {
      type: 'DEMANDE_CERTIFICATION',
      correlation_id: 'corr-123',
      reply_to: 'q.reply',
      headers: { source: 'AE-MESSAGERIE' }
    });
    payloadMutable.nested.valeur = 'modifiee-apres-publish';

    await broker.publish(AMQP_EXCHANGES.COMMANDES, 'cle.fifo', { ordre: 2 });

    const recus: AmqpMessage<{ ordre: number; nested?: { valeur: string } }>[] = [];
    const tag = await broker.consume<{ ordre: number; nested?: { valeur: string } }>(
      'q.fifo',
      (msg) => {
        recus.push(msg);
      }
    );

    expect(recus).toHaveLength(2);
    expect(recus[0]?.payload).toEqual({ ordre: 1, nested: { valeur: 'initiale' } });
    expect(recus[1]?.payload).toEqual({ ordre: 2 });

    const props = recus[0]?.properties;
    expect(props?.content_type).toBe('application/json');
    expect(props?.delivery_mode).toBe(2);
    expect(props?.message_id).toBeTruthy();
    expect(props?.timestamp).toBeTruthy();
    expect(props?.type).toBe('DEMANDE_CERTIFICATION');
    expect(props?.correlation_id).toBe('corr-123');
    expect(props?.reply_to).toBe('q.reply');
    expect(props?.headers).toEqual({ source: 'AE-MESSAGERIE' });

    broker.unsubscribe('q.fifo', tag);
    await broker.publish(AMQP_EXCHANGES.COMMANDES, 'cle.fifo', { ordre: 3 });
    expect(recus).toHaveLength(2);
  });
});

describe('Slice 2 — Primitives cryptographiques et hiérarchie d’AC à 3 niveaux', () => {
  it('fournit RSA-2048, conversions PEM/Base64, scrypt+timingSafeEqual, signatures et chiffrement hybride RSA-OAEP-256 + AES-256-GCM', () => {
    const alice = generateRsaKeyPair();
    const bob = generateRsaKeyPair();

    const base64 = publicKeyPemToBase64(alice.publicKeyPem);
    expect(base64).toBe(alice.publicKeyBase64);
    expect(publicKeyBase64ToPem(base64)).toContain('-----BEGIN PUBLIC KEY-----');

    const hash = hashPassword('SecretP@ss2026!');
    expect(verifyPassword('SecretP@ss2026!', hash)).toBe(true);
    expect(verifyPassword('MauvaisMotDePasse', hash)).toBe(false);

    const msg = 'Bonjour Bob, message confidentiel et signé.';
    const sig = signMessageText(msg, alice.privateKeyPem);
    expect(verifyMessageSignature(msg, sig, alice.publicKeyBase64)).toBe(true);
    expect(verifyMessageSignature(`${msg}!`, sig, alice.publicKeyBase64)).toBe(false);

    const chiffre = encryptHybridMessage(msg, bob.publicKeyBase64);
    expect(chiffre).not.toContain('Bonjour Bob');
    expect(decryptHybridMessage(chiffre, bob.privateKeyPem)).toBe(msg);
    expect(() => decryptHybridMessage(chiffre, alice.privateKeyPem)).toThrow();

    const lcrSansSig: Omit<ListeCertificatsRevoques, 'signatureAc'> = {
      identifiantAc: 'AC-N3-DSI-MESSAGERIE',
      numeroVersionLcr: 1,
      dateEmission: '2026-11-26T10:00:00Z',
      prochaineMiseAJour: '2026-11-27T10:00:00Z',
      entrees: []
    };
    const lcr = signLcr(lcrSansSig, alice.privateKeyPem);
    expect(verifyLcrSignature(lcr, alice.publicKeyBase64)).toBe(true);
    expect(
      verifyLcrSignature({ ...lcr, numeroVersionLcr: 2 }, alice.publicKeyBase64)
    ).toBe(false);
  });

  it('amorce la hiérarchie d’AC sur 3 niveaux avec numéros de série uniques, signatures cryptographiques valides et publications AMQP', async () => {
    const broker = new InMemoryAmqpBroker();
    broker.declareExchange(AMQP_EXCHANGES.PUBLICATIONS, 'topic', { durable: true });
    broker.declareQueue('q.audit.ac', { durable: true });
    broker.bindQueue('q.audit.ac', AMQP_EXCHANGES.PUBLICATIONS, 'certificat.*.ac');

    const publications: AmqpMessage<PublicationCertificatPayload>[] = [];
    await broker.consume<PublicationCertificatPayload>('q.audit.ac', (msg) => {
      publications.push(msg);
    });

    const hierarchie = await amorcerHierarchieAc(broker);

    const certN1 = hierarchie.racine.getCertificatAc();
    const certN2Dsi = hierarchie.directions.dsi.getCertificatAc();
    const certN2Infra = hierarchie.directions.infra.getCertificatAc();
    const certN3Msg = hierarchie.services.dsiMessagerie.getCertificatAc();
    const certN3Reseau = hierarchie.services.infraReseau.getCertificatAc();

    // Unicité des numéros de série dans le Domaine de confiance
    const serials = [
      certN1.numeroSerie,
      certN2Dsi.numeroSerie,
      certN2Infra.numeroSerie,
      certN3Msg.numeroSerie,
      certN3Reseau.numeroSerie
    ];
    expect(new Set(serials).size).toBe(5);
    expect(hierarchie.generateurNumeroSerie).toBeInstanceOf(GenerateurNumeroSerie);

    // Vérification de la chaîne cryptographique et des usages
    expect(certN1.identifiantAcEmettrice).toBe('AC-N1-RACINE');
    expect(certN1.usage).toBe('CERTIFICATION_AC');
    expect(verifyCertificatSignature(certN1, certN1.clePublique)).toBe(true);

    expect(certN2Dsi.identifiantAcEmettrice).toBe('AC-N1-RACINE');
    expect(verifyCertificatSignature(certN2Dsi, certN1.clePublique)).toBe(true);
    expect(verifyCertificatSignature(certN2Infra, certN1.clePublique)).toBe(true);

    expect(certN3Msg.identifiantAcEmettrice).toBe('AC-N2-DSI');
    expect(verifyCertificatSignature(certN3Msg, certN2Dsi.clePublique)).toBe(true);
    expect(verifyCertificatSignature({ ...certN3Msg, sujet: 'falsifie' }, certN2Dsi.clePublique)).toBe(false);

    expect(certN3Reseau.identifiantAcEmettrice).toBe('AC-N2-INFRA');
    expect(verifyCertificatSignature(certN3Reseau, certN2Infra.clePublique)).toBe(true);

    // Vérification des 5 publications AMQP sur ex.pki.publications
    expect(publications).toHaveLength(5);
    expect(publications.map((p) => p.routingKey)).toEqual([
      'certificat.n1.ac',
      'certificat.n2.ac',
      'certificat.n2.ac',
      'certificat.n3.ac',
      'certificat.n3.ac'
    ]);
    expect(publications[0]?.properties.type).toBe('PUBLICATION_CERTIFICAT');
  });
});

describe('Slice 3 — Service de Publication (q.pki.publication.flux et façade REST /annuaire)', () => {
  it('consomme q.pki.publication.flux en temps réel et expose les routes REST /annuaire avec ou sans préfixe /api/v1', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    // Vérification du câblage AMQP attendu
    const bindings = broker.listBindings();
    expect(bindings).toContainEqual({
      queue: 'q.pki.publication.flux',
      exchange: AMQP_EXCHANGES.PUBLICATIONS,
      routingKey: '#'
    });

    const hierarchie = await amorcerHierarchieAc(broker);
    const certN1 = hierarchie.racine.getCertificatAc();
    const certN2Dsi = hierarchie.directions.dsi.getCertificatAc();
    const certN3Msg = hierarchie.services.dsiMessagerie.getCertificatAc();

    // GET /annuaire/autorites (sans et avec filtre niveau)
    const repAutorites = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/autorites'
    });
    expect(repAutorites.status).toBe(200);
    expect((repAutorites.body as AutoriteCertificationInfo[])).toHaveLength(5);

    const repAutoritesN3 = annuaire.handleRestRequest({
      method: 'GET',
      path: '/api/v1/annuaire/autorites',
      query: { niveau: 3 }
    });
    expect(repAutoritesN3.status).toBe(200);
    const listeN3 = repAutoritesN3.body as AutoriteCertificationInfo[];
    expect(listeN3.map((a) => a.acId)).toEqual([
      'AC-N3-DSI-MESSAGERIE',
      'AC-N3-INFRA-RESEAU'
    ]);

    // GET /annuaire/certificats avec filtres
    const repCerts = annuaire.handleRestRequest({
      method: 'GET',
      path: '/api/v1/annuaire/certificats',
      query: {
        acEmettriceId: 'AC-N1-RACINE',
        usage: 'CERTIFICATION_AC',
        uniquementValides: true
      }
    });
    expect(repCerts.status).toBe(200);
    // N1 auto-signé + N2-DSI + N2-INFRA = 3 certificats émis par AC-N1-RACINE
    expect((repCerts.body as Certificat[])).toHaveLength(3);

    const repCertBySujet = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: 'AC-N3-DSI-MESSAGERIE' }
    });
    expect(repCertBySujet.status).toBe(200);
    expect((repCertBySujet.body as Certificat[])).toHaveLength(1);
    expect((repCertBySujet.body as Certificat[])[0]?.numeroSerie).toBe(certN3Msg.numeroSerie);

    // GET /annuaire/certificats/{numeroSerie}
    const repCertDetail = annuaire.handleRestRequest({
      method: 'GET',
      path: `/annuaire/certificats/${certN3Msg.numeroSerie}`
    });
    expect(repCertDetail.status).toBe(200);
    expect((repCertDetail.body as Certificat).sujet).toBe('AC-N3-DSI-MESSAGERIE');

    const repCertInconnu = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats/SN-INCONNU'
    });
    expect(repCertInconnu.status).toBe(404);
    expect((repCertInconnu.body as ErreurApi).code).toBeTruthy();

    // GET /annuaire/certificats/{numeroSerie}/chemin-certification
    const repChemin = annuaire.handleRestRequest({
      method: 'GET',
      path: `/api/v1/annuaire/certificats/${certN3Msg.numeroSerie}/chemin-certification`
    });
    expect(repChemin.status).toBe(200);
    const chemin = repChemin.body as CheminCertificationReponse;
    expect(chemin.numeroSerieCible).toBe(certN3Msg.numeroSerie);
    expect(chemin.profondeurHierarchie).toBe(3);
    expect(chemin.chaineCertificats.map((c) => c.numeroSerie)).toEqual([
      certN3Msg.numeroSerie,
      certN2Dsi.numeroSerie,
      certN1.numeroSerie
    ]);

    // GET /annuaire/autorites/{acId}/lcr et GET /annuaire/lcr
    const repLcrAc = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/autorites/AC-N3-DSI-MESSAGERIE/lcr'
    });
    expect(repLcrAc.status).toBe(200);
    const lcrAc = repLcrAc.body as ListeCertificatsRevoques;
    expect(lcrAc.identifiantAc).toBe('AC-N3-DSI-MESSAGERIE');
    expect(verifyLcrSignature(lcrAc, certN3Msg.clePublique)).toBe(true);

    const repLcrInconnue = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/autorites/AC-INCONNUE/lcr'
    });
    expect(repLcrInconnue.status).toBe(404);

    const repLcrConsolidee = annuaire.handleRestRequest({
      method: 'GET',
      path: '/api/v1/annuaire/lcr'
    });
    expect(repLcrConsolidee.status).toBe(200);
    expect((repLcrConsolidee.body as ListeCertificatsRevoques[])).toHaveLength(5);
  });

  it('filtre les certificats expirés ou révoqués via uniquementValides et attend les consommateurs asynchrones en ordre', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker);
    const acN3 = hierarchie.services.dsiMessagerie;
    const porteurKey = generateRsaKeyPair();

    // Publication d'un certificat expiré et d'un certificat actif puis révoqué via LCR
    const certExpire = signCertificat(
      {
        numeroSerie: hierarchie.generateurNumeroSerie.generer('PORT-EXP'),
        identifiantAcEmettrice: acN3.acId,
        niveauAcEmettrice: 3,
        dateDebutValidite: '2020-01-01T00:00:00Z',
        dateFinValidite: '2021-01-01T00:00:00Z',
        usage: 'SIGNATURE',
        sujet: 'expire@dsi.organisation.fr',
        clePublique: porteurKey.publicKeyBase64,
        algorithmeSignature: 'SHA256withRSA'
      },
      generateRsaKeyPair().privateKeyPem
    );

    const certRevoque = signCertificat(
      {
        numeroSerie: hierarchie.generateurNumeroSerie.generer('PORT-REV'),
        identifiantAcEmettrice: acN3.acId,
        niveauAcEmettrice: 3,
        dateDebutValidite: new Date(Date.now() - 60_000).toISOString(),
        dateFinValidite: new Date(Date.now() + 86_400_000).toISOString(),
        usage: 'SIGNATURE',
        sujet: 'revoque@dsi.organisation.fr',
        clePublique: porteurKey.publicKeyBase64,
        algorithmeSignature: 'SHA256withRSA'
      },
      generateRsaKeyPair().privateKeyPem
    );

    await broker.publish(
      AMQP_EXCHANGES.PUBLICATIONS,
      'certificat.n3.porteur',
      { certificat: certExpire },
      { type: 'PUBLICATION_CERTIFICAT' }
    );
    await broker.publish(
      AMQP_EXCHANGES.PUBLICATIONS,
      'certificat.n3.porteur',
      { certificat: certRevoque },
      { type: 'PUBLICATION_CERTIFICAT' }
    );
    await broker.publish(
      AMQP_EXCHANGES.PUBLICATIONS,
      'lcr.n3.ac-n3-dsi-messagerie',
      {
        lcr: {
          identifiantAc: acN3.acId,
          numeroVersionLcr: 2,
          dateEmission: new Date().toISOString(),
          prochaineMiseAJour: new Date(Date.now() + 86_400_000).toISOString(),
          entrees: [
            {
              numeroSerieCertificat: certRevoque.numeroSerie,
              statut: 'REVOQUE',
              dateInvalidation: new Date().toISOString(),
              motif: 'COMPROMISSION_CLE_PRIVEE'
            }
          ],
          signatureAc: 'sig-test'
        }
      },
      { type: 'PUBLICATION_LCR' }
    );

    const repValides = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { acEmettriceId: acN3.acId, uniquementValides: true }
    });
    expect(repValides.status).toBe(200);
    expect((repValides.body as Certificat[])).toHaveLength(0);

    const repTous = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats?uniquementValides=false',
      query: { acEmettriceId: acN3.acId }
    });
    expect(repTous.status).toBe(200);
    expect((repTous.body as Certificat[])).toHaveLength(2);
  });
});
