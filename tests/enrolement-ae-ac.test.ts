import { describe, it, expect } from 'vitest';
import {
  InMemoryAmqpBroker,
  AMQP_EXCHANGES,
  amorcerHierarchieAc,
  AutoriteEnregistrement,
  ServicePublication,
  generateRsaKeyPair,
  verifyCertificatSignature,
  signMessageText,
  verifyMessageSignature
} from '../src/index.js';
import type {
  AmqpMessage,
  Certificat,
  CheminCertificationReponse,
  DemandeCertificationReponse,
  DroitsEntiteAE,
  ErreurApi
} from '../src/index.js';

function basicAuthHeader(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf8').toString('base64')}`;
}

describe('Slice 1 — Registre AE par nature et consultation des droits (GET /ae/{nature}/entites/{nomEntite}/droits)', () => {
  it('authentifie via HTTP Basic, rejette 401/404 (y compris X-Mot-De-Passe seul) et ne divulgue jamais le mot de passe ou son condensat', async () => {
    const broker = new InMemoryAmqpBroker();
    const ae = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await ae.ready();

    // Déclaration AMQP attendue côté AE
    expect(broker.listExchanges()).toContainEqual({
      name: AMQP_EXCHANGES.COMMANDES,
      type: 'direct',
      durable: true
    });
    expect(broker.listBindings()).toContainEqual({
      queue: 'q.pki.ae.ae-messagerie.reponses',
      exchange: AMQP_EXCHANGES.COMMANDES,
      routingKey: 'ae.ae-messagerie'
    });

    // 404 si entité inconnue
    const repInconnue = await ae.handleRestRequest({
      method: 'GET',
      path: '/ae/messagerie/entites/inconnu@dsi.organisation.fr/droits',
      headers: {
        Authorization: basicAuthHeader('inconnu@dsi.organisation.fr', 'SecretP@ss2026!')
      }
    });
    expect(repInconnue.status).toBe(404);
    expect((repInconnue.body as ErreurApi).code).toBeTruthy();

    // 401 si identifiants absents
    const repSansAuth = await ae.handleRestRequest({
      method: 'GET',
      path: '/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits'
    });
    expect(repSansAuth.status).toBe(401);

    // 401 si mot de passe erroné
    const repMauvaisMdp = await ae.handleRestRequest({
      method: 'GET',
      path: '/api/v1/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
      headers: {
        Authorization: basicAuthHeader('alice.martin@dsi.organisation.fr', 'MauvaisMdp!')
      }
    });
    expect(repMauvaisMdp.status).toBe(401);

    // 401 si l'utilisateur Basic ne correspond pas au nomEntite ciblé
    const repMauvaisUser = await ae.handleRestRequest({
      method: 'GET',
      path: '/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
      headers: {
        Authorization: basicAuthHeader('autre@dsi.organisation.fr', 'SecretP@ss2026!')
      }
    });
    expect(repMauvaisUser.status).toBe(401);

    // 200 avec HTTP Basic (avec préfixe /api/v1)
    const repOkBasic = await ae.handleRestRequest({
      method: 'GET',
      path: '/api/v1/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
      headers: {
        authorization: basicAuthHeader('alice.martin@dsi.organisation.fr', 'SecretP@ss2026!')
      }
    });
    expect(repOkBasic.status).toBe(200);
    const droits = repOkBasic.body as DroitsEntiteAE;
    expect(droits).toEqual({
      nomEntite: 'alice.martin@dsi.organisation.fr',
      natureRessource: 'messagerie',
      droitSignature: true,
      droitChiffrement: true,
      droitDemandeRevocation: true,
      acRattachementId: 'AC-N3-DSI-MESSAGERIE'
    });
    expect(JSON.stringify(droits)).not.toContain('SecretP@ss2026!');
    expect(JSON.stringify(droits)).not.toContain('motDePasse');

    // 401 si seul l'en-tête non standard X-Mot-De-Passe est fourni (sans Authorization Basic)
    const repFallbackRejete = await ae.handleRestRequest({
      method: 'GET',
      path: '/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
      headers: {
        'X-Mot-De-Passe': 'SecretP@ss2026!'
      }
    });
    expect(repFallbackRejete.status).toBe(401);

    // 200 avec HTTP Basic (sans préfixe /api/v1)
    const repOkSansPrefixe = await ae.handleRestRequest({
      method: 'GET',
      path: '/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
      headers: {
        Authorization: basicAuthHeader('alice.martin@dsi.organisation.fr', 'SecretP@ss2026!')
      }
    });
    expect(repOkSansPrefixe.status).toBe(200);
    expect((repOkSansPrefixe.body as DroitsEntiteAE).acRattachementId).toBe(
      'AC-N3-DSI-MESSAGERIE'
    );

    // 404 si nature incompatible avec l'AE
    const repMauvaiseNature = await ae.handleRestRequest({
      method: 'GET',
      path: '/ae/routeurs/entites/alice.martin@dsi.organisation.fr/droits',
      headers: {
        Authorization: basicAuthHeader('alice.martin@dsi.organisation.fr', 'SecretP@ss2026!')
      }
    });
    expect(repMauvaiseNature.status).toBe(404);
  });
});

describe('Slice 2 — Validation, authentification (401), droits (403) et résolution AC (404) sur POST /ae/{nature}/demandes-certification', () => {
  it('rejette en 400 les requêtes invalides, en 401 les échecs d’authentification, en 403 les usages non autorisés et en 404 les AC cibles inconnues', async () => {
    const broker = new InMemoryAmqpBroker();
    await amorcerHierarchieAc(broker);

    const ae = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      entites: [
        {
          nomEntite: 'sign-only@dsi.organisation.fr',
          motDePasse: 'PassSign1!',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'crypt-only@dsi.organisation.fr',
          motDePasse: 'PassCrypt1!',
          droitSignature: false,
          droitChiffrement: true,
          droitDemandeRevocation: false,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await ae.ready();

    const keyPair = generateRsaKeyPair();

    // 400 si clé publique manquante et genererBicle = false
    const repSansCle = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'sign-only@dsi.organisation.fr',
        motDePasse: 'PassSign1!',
        usage: 'SIGNATURE',
        genererBicle: false
      }
    });
    expect(repSansCle.status).toBe(400);

    // 400 si usage CERTIFICATION_AC demandé par un Porteur
    const repUsageAc = await ae.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'sign-only@dsi.organisation.fr',
        motDePasse: 'PassSign1!',
        usage: 'CERTIFICATION_AC',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repUsageAc.status).toBe(400);

    // 401 si entité inconnue ou mot de passe erroné
    const repInconnu = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'absent@dsi.organisation.fr',
        motDePasse: 'PassSign1!',
        usage: 'SIGNATURE',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repInconnu.status).toBe(401);

    const repMauvaisMdp = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'sign-only@dsi.organisation.fr',
        motDePasse: 'MauvaisPass!',
        usage: 'SIGNATURE',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repMauvaisMdp.status).toBe(401);

    // 403 si droitChiffrement=false pour CHIFFREMENT ou SIGNATURE_ET_CHIFFREMENT
    const repChiffrementRefuse = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'sign-only@dsi.organisation.fr',
        motDePasse: 'PassSign1!',
        usage: 'CHIFFREMENT',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repChiffrementRefuse.status).toBe(403);

    const repMixteRefuse = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'sign-only@dsi.organisation.fr',
        motDePasse: 'PassSign1!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repMixteRefuse.status).toBe(403);

    // 403 si droitSignature=false pour SIGNATURE
    const repSignatureRefusee = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'crypt-only@dsi.organisation.fr',
        motDePasse: 'PassCrypt1!',
        usage: 'SIGNATURE',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repSignatureRefusee.status).toBe(403);

    // 404 si acCibleId inconnu ou non niveau 3 (ex. AC Racine)
    const repAcInconnue = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'sign-only@dsi.organisation.fr',
        motDePasse: 'PassSign1!',
        acCibleId: 'AC-INCONNUE',
        usage: 'SIGNATURE',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repAcInconnue.status).toBe(404);

    const repAcRacine = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'sign-only@dsi.organisation.fr',
        motDePasse: 'PassSign1!',
        acCibleId: 'AC-N1-RACINE',
        usage: 'SIGNATURE',
        clePublique: keyPair.publicKeyBase64
      }
    });
    expect(repAcRacine.status).toBe(404);
  });
});

describe('Slice 3 — Enrôlement nominal de bout en bout (AE -> ex.pki.commandes -> AC N3 -> ex.pki.publications -> 201 Created)', () => {
  it('émet des Certificats signés avec numéros de série uniques, publie sur certificat.n3.<nature> et alimente le Chemin de certification 3 niveaux', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker);

    // Vérifier le câblage AMQP des AC de niveau 3
    expect(broker.listBindings()).toContainEqual({
      queue: 'q.pki.ac.AC-N3-DSI-MESSAGERIE.demandes',
      exchange: AMQP_EXCHANGES.COMMANDES,
      routingKey: 'ac.AC-N3-DSI-MESSAGERIE'
    });
    expect(broker.listBindings()).toContainEqual({
      queue: 'q.pki.ac.AC-N3-INFRA-RESEAU.demandes',
      exchange: AMQP_EXCHANGES.COMMANDES,
      routingKey: 'ac.AC-N3-INFRA-RESEAU'
    });

    // Audit AMQP sur ex.pki.publications pour certificat.n3.messagerie
    broker.declareQueue('q.audit.pub.n3.messagerie', { durable: true });
    broker.bindQueue(
      'q.audit.pub.n3.messagerie',
      AMQP_EXCHANGES.PUBLICATIONS,
      'certificat.n3.messagerie'
    );
    const publicationsPorteur: AmqpMessage[] = [];
    await broker.consume('q.audit.pub.n3.messagerie', (msg) => {
      publicationsPorteur.push(msg);
    });

    const aeMessagerie = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'bob.dupont@dsi.organisation.fr',
          motDePasse: 'BobSecret#2026',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await aeMessagerie.ready();

    const aliceKeys = generateRsaKeyPair();
    const bobKeys = generateRsaKeyPair();

    // Demande 1 (acCibleId explicite)
    const repAlice = await aeMessagerie.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        acCibleId: 'AC-N3-DSI-MESSAGERIE',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: aliceKeys.publicKeyBase64,
        genererBicle: false
      }
    });

    expect(repAlice.status).toBe(201);
    const bodyAlice = repAlice.body as DemandeCertificationReponse;
    expect(bodyAlice.statutDemande).toBe('EMISE');
    expect(bodyAlice.demandeId).toBeTruthy();
    expect(bodyAlice.clePriveeGeneree).toBeNull();
    expect(bodyAlice.certificat).toBeDefined();

    const certAlice = bodyAlice.certificat as Certificat;
    expect(certAlice.sujet).toBe('alice.martin@dsi.organisation.fr');
    expect(certAlice.identifiantAcEmettrice).toBe('AC-N3-DSI-MESSAGERIE');
    expect(certAlice.niveauAcEmettrice).toBe(3);
    expect(certAlice.natureRessource).toBe('messagerie');
    expect(certAlice.usage).toBe('SIGNATURE_ET_CHIFFREMENT');
    expect(certAlice.clePublique).toBe(aliceKeys.publicKeyBase64);

    // Demande 2 (acCibleId omis -> déduit de acRattachementId)
    const repBob = await aeMessagerie.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'bob.dupont@dsi.organisation.fr',
        motDePasse: 'BobSecret#2026',
        usage: 'SIGNATURE',
        clePublique: bobKeys.publicKeyPem
      }
    });

    expect(repBob.status).toBe(201);
    const certBob = (repBob.body as DemandeCertificationReponse).certificat as Certificat;
    expect(certBob.numeroSerie).not.toBe(certAlice.numeroSerie);
    expect(certBob.clePublique).toBe(bobKeys.publicKeyBase64);

    // Vérification publication AMQP certificat.n3.messagerie
    expect(publicationsPorteur).toHaveLength(2);
    expect(publicationsPorteur[0]?.properties.type).toBe('PUBLICATION_CERTIFICAT');
    expect(publicationsPorteur[0]?.routingKey).toBe('certificat.n3.messagerie');

    // Vérification dans le Service de Publication + Chemin de certification 3 niveaux
    const repAnnuaireCert = annuaire.handleRestRequest({
      method: 'GET',
      path: `/annuaire/certificats/${certAlice.numeroSerie}`
    });
    expect(repAnnuaireCert.status).toBe(200);
    expect((repAnnuaireCert.body as Certificat).numeroSerie).toBe(certAlice.numeroSerie);

    const repChemin = annuaire.handleRestRequest({
      method: 'GET',
      path: `/api/v1/annuaire/certificats/${certAlice.numeroSerie}/chemin-certification`
    });
    expect(repChemin.status).toBe(200);
    const chemin = repChemin.body as CheminCertificationReponse;
    expect(chemin.profondeurHierarchie).toBe(3);
    expect(chemin.chaineCertificats).toHaveLength(4);
    expect(chemin.chaineCertificats.map((c) => c.sujet)).toEqual([
      'alice.martin@dsi.organisation.fr',
      'AC-N3-DSI-MESSAGERIE',
      'AC-N2-DSI',
      'AC-N1-RACINE'
    ]);

    // Vérification cryptographique complète de la chaîne jusqu'à AC-N1-RACINE
    const [cPorteur, cN3, cN2, cN1] = chemin.chaineCertificats as [
      Certificat,
      Certificat,
      Certificat,
      Certificat
    ];
    expect(verifyCertificatSignature(cPorteur, cN3.clePublique)).toBe(true);
    expect(verifyCertificatSignature(cN3, cN2.clePublique)).toBe(true);
    expect(verifyCertificatSignature(cN2, cN1.clePublique)).toBe(true);
    expect(verifyCertificatSignature(cN1, hierarchie.racine.clePubliqueBase64)).toBe(true);
  });
});

describe('Slice 4 — Génération optionnelle de Biclé (genererBicle: true), réponse différée 202 Accepted et confidentialité de la clé privée', () => {
  it('délègue la génération de Biclé en 201 Created, retourne une clé privée fonctionnelle une seule fois et ne la conserve ni côté AC ni côté AE', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker);
    const aeRouteurs = new AutoriteEnregistrement({
      nature: 'routeurs',
      broker,
      entites: [
        {
          nomEntite: 'routeur-core-01.infra.organisation.fr',
          motDePasse: 'RouterAuth#99',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-INFRA-RESEAU'
        }
      ]
    });
    await aeRouteurs.ready();

    const rep = await aeRouteurs.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/routeurs/demandes-certification',
      body: {
        nomEntite: 'routeur-core-01.infra.organisation.fr',
        motDePasse: 'RouterAuth#99',
        acCibleId: 'AC-N3-INFRA-RESEAU',
        usage: 'SIGNATURE',
        genererBicle: true
      }
    });

    expect(rep.status).toBe(201);
    const body = rep.body as DemandeCertificationReponse;
    expect(body.statutDemande).toBe('EMISE');
    expect(body.certificat).toBeDefined();
    expect(typeof body.clePriveeGeneree).toBe('string');
    expect(body.clePriveeGeneree).toContain('BEGIN PRIVATE KEY');

    const cert = body.certificat as Certificat;
    const privPem = body.clePriveeGeneree as string;

    // La Biclé générée correspond cryptographiquement au Certificat signé par l'AC N3
    const signatureTest = signMessageText('verification-bicle', privPem);
    expect(verifyMessageSignature('verification-bicle', signatureTest, cert.clePublique)).toBe(
      true
    );
    expect(
      verifyCertificatSignature(cert, hierarchie.services.infraReseau.clePubliqueBase64)
    ).toBe(true);

    // La clé privée n'est pas conservée par l'AE lors d'un GET ultérieur
    const repSuivi = await aeRouteurs.handleRestRequest({
      method: 'GET',
      path: `/ae/routeurs/demandes-certification/${body.demandeId}`
    });
    expect(repSuivi.status).toBe(200);
    const suiviBody = repSuivi.body as DemandeCertificationReponse;
    expect(suiviBody.statutDemande).toBe('EMISE');
    expect(suiviBody.clePriveeGeneree).toBeNull();
    expect(suiviBody.certificat?.numeroSerie).toBe(cert.numeroSerie);

    // Vérification via le Service de Publication (routing key certificat.n3.routeurs)
    const repChemin = annuaire.handleRestRequest({
      method: 'GET',
      path: `/annuaire/certificats/${cert.numeroSerie}/chemin-certification`
    });
    expect(repChemin.status).toBe(200);
    const chemin = repChemin.body as CheminCertificationReponse;
    expect(chemin.chaineCertificats.map((c) => c.sujet)).toEqual([
      'routeur-core-01.infra.organisation.fr',
      'AC-N3-INFRA-RESEAU',
      'AC-N2-INFRA',
      'AC-N1-RACINE'
    ]);
  });

  it('retourne 202 Accepted avec Location quand l’AC diffère le traitement, puis délivre le résultat (et la clé privée une seule fois) via GET', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker);
    const acReseau = hierarchie.services.infraReseau;

    // Suspension déterministe de la consommation AC pour simuler une réponse différée
    acReseau.suspendreConsommation();

    const aeRouteurs = new AutoriteEnregistrement({
      nature: 'routeurs',
      broker,
      delaiReponseAcMs: 25,
      entites: [
        {
          nomEntite: 'routeur-edge-02.infra.organisation.fr',
          motDePasse: 'EdgeRouter#2026',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-INFRA-RESEAU'
        }
      ]
    });
    await aeRouteurs.ready();

    // 404 sur suivi d'une demande inexistante
    const repInexistante = await aeRouteurs.handleRestRequest({
      method: 'GET',
      path: '/ae/routeurs/demandes-certification/00000000-0000-0000-0000-000000000000'
    });
    expect(repInexistante.status).toBe(404);

    const repDifferee = await aeRouteurs.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/routeurs/demandes-certification',
      body: {
        nomEntite: 'routeur-edge-02.infra.organisation.fr',
        motDePasse: 'EdgeRouter#2026',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        genererBicle: true
      }
    });

    expect(repDifferee.status).toBe(202);
    const body202 = repDifferee.body as DemandeCertificationReponse;
    expect(body202.statutDemande).toBe('EN_ATTENTE_AC');
    expect(body202.clePriveeGeneree).toBeNull();
    expect(repDifferee.headers?.Location).toBe(
      `/api/v1/ae/routeurs/demandes-certification/${body202.demandeId}`
    );

    // Consultation pendant l'attente
    const repEnAttente = await aeRouteurs.handleRestRequest({
      method: 'GET',
      path: repDifferee.headers?.Location ?? ''
    });
    expect(repEnAttente.status).toBe(200);
    expect((repEnAttente.body as DemandeCertificationReponse).statutDemande).toBe(
      'EN_ATTENTE_AC'
    );

    // Reprise de l'AC : traitement FIFO de q.pki.ac.AC-N3-INFRA-RESEAU.demandes et réponse corrélée
    await acReseau.reprendreConsommation();

    // Premier GET après émission : récupère le Certificat et la clé privée générée une seule fois
    const repPrete = await aeRouteurs.handleRestRequest({
      method: 'GET',
      path: `/api/v1/ae/routeurs/demandes-certification/${body202.demandeId}`
    });
    expect(repPrete.status).toBe(200);
    const bodyPrete = repPrete.body as DemandeCertificationReponse;
    expect(bodyPrete.statutDemande).toBe('EMISE');
    expect(bodyPrete.certificat).toBeDefined();
    expect(typeof bodyPrete.clePriveeGeneree).toBe('string');
    expect(bodyPrete.clePriveeGeneree).toContain('BEGIN PRIVATE KEY');

    const sig = signMessageText('test-differe', bodyPrete.clePriveeGeneree as string);
    expect(
      verifyMessageSignature('test-differe', sig, bodyPrete.certificat!.clePublique)
    ).toBe(true);

    // Deuxième GET : la clé privée a été purgée et n'est plus jamais disponible
    const repSecondeLecture = await aeRouteurs.handleRestRequest({
      method: 'GET',
      path: `/ae/routeurs/demandes-certification/${body202.demandeId}`
    });
    expect(repSecondeLecture.status).toBe(200);
    const bodySeconde = repSecondeLecture.body as DemandeCertificationReponse;
    expect(bodySeconde.statutDemande).toBe('EMISE');
    expect(bodySeconde.clePriveeGeneree).toBeNull();

    // Certificat publié et consultable dans l'annuaire
    const repAnnuaire = annuaire.handleRestRequest({
      method: 'GET',
      path: `/annuaire/certificats/${bodyPrete.certificat!.numeroSerie}`
    });
    expect(repAnnuaire.status).toBe(200);
  });

  it('purge automatiquement une clePriveeGeneree différée après expiration du TTL (ttlClePriveeEphemeresMs)', async () => {
    const broker = new InMemoryAmqpBroker();
    const hierarchie = await amorcerHierarchieAc(broker);
    const acReseau = hierarchie.services.infraReseau;

    acReseau.suspendreConsommation();

    const aeRouteurs = new AutoriteEnregistrement({
      nature: 'routeurs',
      broker,
      delaiReponseAcMs: 20,
      ttlClePriveeEphemeresMs: 40,
      entites: [
        {
          nomEntite: 'routeur-ttl-03.infra.organisation.fr',
          motDePasse: 'TtlRouter#2026',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-INFRA-RESEAU'
        }
      ]
    });
    await aeRouteurs.ready();

    try {
      const repDifferee = await aeRouteurs.handleRestRequest({
        method: 'POST',
        path: '/api/v1/ae/routeurs/demandes-certification',
        body: {
          nomEntite: 'routeur-ttl-03.infra.organisation.fr',
          motDePasse: 'TtlRouter#2026',
          usage: 'SIGNATURE',
          genererBicle: true
        }
      });

      expect(repDifferee.status).toBe(202);
      const body202 = repDifferee.body as DemandeCertificationReponse;

      await acReseau.reprendreConsommation();
      await new Promise((resolve) => setTimeout(resolve, 80));

      const repExpiree = await aeRouteurs.handleRestRequest({
        method: 'GET',
        path: `/api/v1/ae/routeurs/demandes-certification/${body202.demandeId}`
      });
      expect(repExpiree.status).toBe(200);
      const bodyExpiree = repExpiree.body as DemandeCertificationReponse;
      expect(bodyExpiree.statutDemande).toBe('EMISE');
      expect(bodyExpiree.certificat).toBeDefined();
      expect(bodyExpiree.clePriveeGeneree).toBeNull();
    } finally {
      await aeRouteurs.arreter();
    }
  });
});
