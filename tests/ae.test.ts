import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import { bootstrapHierarchieAc } from '../src/ac/index.js';
import { ServicePublication } from '../src/annuaire/index.js';
import {
  generateRsaKeyPair,
  verifyCertificatSignature,
  base64ToPublicKeyPem,
} from '../src/crypto/index.js';
import {
  AutoriteEnregistrement,
  bootstrapAutoritesEnregistrement,
} from '../src/ae/index.js';
import type {
  DroitsEntiteAE,
  ErreurApi,
  Certificat,
  DemandeCertificationReponse,
  CheminCertificationReponse,
} from '../src/types/index.js';


describe('Autorité d\'Enregistrement (AE) & Enrôlement Porteur', () => {
  let broker: InMemoryJmsBroker;

  beforeEach(() => {
    broker = new InMemoryJmsBroker();
  });

  describe('Gestion du registre des entités et consultation des droits (GET /ae/{nature}/entites/{nomEntite}/droits)', () => {
    it('should return 404 when querying rights of an unknown entity', async () => {
      const aeManager = bootstrapAutoritesEnregistrement(broker);

      const res = await aeManager.handleRequest({
        method: 'GET',
        path: '/ae/messagerie/entites/unknown@dsi.organisation.fr/droits',
        headers: {
          'X-Entite-Mot-De-Passe': 'somePassword',
        },
      });

      expect(res.status).toBe(404);
      const err = res.body as ErreurApi;
      expect(err.code).toBe('ENTITE_INTROUVABLE');
    });

    it('should return 401 when password is bad or missing', async () => {
      const aeManager = bootstrapAutoritesEnregistrement(broker);
      const aeMessagerie = aeManager.getAeParNature('messagerie');

      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Missing password header
      const resMissing = await aeManager.handleRequest({
        method: 'GET',
        path: '/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
      });
      expect(resMissing.status).toBe(401);
      expect((resMissing.body as ErreurApi).code).toBe('NON_AUTHENTIFIE');

      // Wrong password header
      const resWrong = await aeManager.handleRequest({
        method: 'GET',
        path: '/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
        headers: {
          'X-Entite-Mot-De-Passe': 'BadPassword!',
        },
      });
      expect(resWrong.status).toBe(401);
      expect((resWrong.body as ErreurApi).code).toBe('NON_AUTHENTIFIE');
    });

    it('should return 200 with DroitsEntiteAE when authenticated with correct password', async () => {
      const aeManager = bootstrapAutoritesEnregistrement(broker);
      const aeMessagerie = aeManager.getAeParNature('messagerie');

      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: false,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const res = await aeManager.handleRequest({
        method: 'GET',
        path: '/ae/messagerie/entites/alice.martin@dsi.organisation.fr/droits',
        headers: {
          'X-Entite-Mot-De-Passe': 'SecretP@ss2026!',
        },
      });

      expect(res.status).toBe(200);
      const droits = res.body as DroitsEntiteAE;
      expect(droits.nomEntite).toBe('alice.martin@dsi.organisation.fr');
      expect(droits.natureRessource).toBe('messagerie');
      expect(droits.droitSignature).toBe(true);
      expect(droits.droitChiffrement).toBe(false);
      expect(droits.droitDemandeRevocation).toBe(true);
      expect(droits.acRattachementId).toBe('AC-N3-DSI-MESSAGERIE');
    });
  });

  describe('Validation des droits et authentification lors de la demande (POST /ae/{nature}/demandes-certification)', () => {
    it('should return 401 when entity is unknown or password is bad', async () => {
      const aeManager = bootstrapAutoritesEnregistrement(broker);
      const aeMessagerie = aeManager.getAeParNature('messagerie');

      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Unknown entity
      const resUnknown = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'bob.unknown@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE',
          clePublique: 'fakePubKey',
        },
      });
      expect(resUnknown.status).toBe(401);
      expect((resUnknown.body as ErreurApi).code).toBe('NON_AUTHENTIFIE');

      // Wrong password
      const resBadPass = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'WrongPassword!',
          usage: 'SIGNATURE',
          clePublique: 'fakePubKey',
        },
      });
      expect(resBadPass.status).toBe(401);
      expect((resBadPass.body as ErreurApi).code).toBe('NON_AUTHENTIFIE');
    });

    it('should return 403 when entity lacks requested usage rights', async () => {
      const aeManager = bootstrapAutoritesEnregistrement(broker);
      const aeMessagerie = aeManager.getAeParNature('messagerie');

      // User has only droitSignature: true
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: false,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Requests CHIFFREMENT
      const resChiffrement = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'CHIFFREMENT',
          clePublique: 'fakePubKey',
        },
      });
      expect(resChiffrement.status).toBe(403);
      expect((resChiffrement.body as ErreurApi).code).toBe('DROITS_INSUFFISANTS');

      // Requests SIGNATURE_ET_CHIFFREMENT
      const resBoth = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: 'fakePubKey',
        },
      });
      expect(resBoth.status).toBe(403);
      expect((resBoth.body as ErreurApi).code).toBe('DROITS_INSUFFISANTS');

      // Requests CERTIFICATION_AC
      const resAc = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'CERTIFICATION_AC',
          clePublique: 'fakePubKey',
        },
      });
      expect(resAc.status).toBe(403);
      expect((resAc.body as ErreurApi).code).toBe('DROITS_INSUFFISANTS');
    });

    it('should return 400 when request body is invalid or missing public key when genererBicle is false', async () => {
      const aeManager = bootstrapAutoritesEnregistrement(broker);
      const aeMessagerie = aeManager.getAeParNature('messagerie');

      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Missing clePublique and genererBicle false
      const resMissingKey = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE',
        },
      });
      expect(resMissingKey.status).toBe(400);
      expect((resMissingKey.body as ErreurApi).code).toBe('REQUETE_INVALIDE');
    });
  });

  describe('Création de certificat de bout en bout (AE ↔ JMS ↔ AC Niveau 3 → Service de Publication)', () => {
    it('should complete nominal mode enrollment with client public key, return 201, and index on Annuaire with 4-link chain', async () => {
      // 1. Setup full environment: Broker, AC Hierarchy, Annuaire, AE
      const hierarchie = bootstrapHierarchieAc(broker);
      const annuaire = new ServicePublication(broker);
      annuaire.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

      const aeManager = bootstrapAutoritesEnregistrement(broker);
      const aeMessagerie = aeManager.getAeParNature('messagerie');

      // Register Alice
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        natureRessource: 'messagerie',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Alice generates her own keypair locally
      const aliceKeyPair = generateRsaKeyPair();

      // Alice submits certification request
      const resCreation = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: aliceKeyPair.publicKeyBase64,
          genererBicle: false,
        },
      });

      expect(resCreation.status).toBe(201);
      const bodyReponse = resCreation.body as DemandeCertificationReponse;
      expect(bodyReponse.statutDemande).toBe('EMISE');
      expect(bodyReponse.demandeId).toBeDefined();
      expect(bodyReponse.certificat).toBeDefined();
      expect(bodyReponse.clePriveeGeneree).toBeNull();

      const certAlice = bodyReponse.certificat!;
      expect(certAlice.numeroSerie).toMatch(/^SN-2026-/);
      expect(certAlice.sujet).toBe('alice.martin@dsi.organisation.fr');
      expect(certAlice.identifiantAcEmettrice).toBe('AC-N3-DSI-MESSAGERIE');
      expect(certAlice.usage).toBe('SIGNATURE_ET_CHIFFREMENT');
      expect(certAlice.clePublique).toBe(aliceKeyPair.publicKeyBase64);

      // Verify cryptographic signature made by AC-N3-DSI-MESSAGERIE
      const acN3 = hierarchie.allAcs.find((ac) => ac.id === 'AC-N3-DSI-MESSAGERIE')!;
      expect(verifyCertificatSignature(certAlice, acN3.certificat.clePublique)).toBe(true);

      // Verify GET /ae/messagerie/demandes-certification/{demandeId} returns status
      const resGetDemande = await aeManager.handleRequest({
        method: 'GET',
        path: `/ae/messagerie/demandes-certification/${bodyReponse.demandeId}`,
      });
      expect(resGetDemande.status).toBe(200);
      const getBody = resGetDemande.body as DemandeCertificationReponse;
      expect(getBody.demandeId).toBe(bodyReponse.demandeId);
      expect(getBody.statutDemande).toBe('EMISE');
      expect(getBody.certificat?.numeroSerie).toBe(certAlice.numeroSerie);

      // Verify Annuaire has indexed the certificate via JMS topic
      const resRecherche = annuaire.handleRequest({
        method: 'GET',
        path: '/annuaire/certificats',
        query: { sujet: 'alice.martin@dsi.organisation.fr' },
      });
      expect(resRecherche.status).toBe(200);
      const certsTrouves = resRecherche.body as Certificat[];
      expect(certsTrouves).toHaveLength(1);
      expect(certsTrouves[0].numeroSerie).toBe(certAlice.numeroSerie);

      // Verify 4-link certification chain (Alice -> AC3 -> AC2 -> AC1 Root)
      const resChemin = annuaire.handleRequest({
        method: 'GET',
        path: `/annuaire/certificats/${certAlice.numeroSerie}/chemin-certification`,
      });
      expect(resChemin.status).toBe(200);
      const chemin = resChemin.body as CheminCertificationReponse;
      expect(chemin.chaineCertificats).toHaveLength(4);
      expect(chemin.chaineCertificats[0].sujet).toBe('alice.martin@dsi.organisation.fr');
      expect(chemin.chaineCertificats[1].sujet).toBe('AC-N3-DSI-MESSAGERIE');
      expect(chemin.chaineCertificats[2].sujet).toBe('AC-N2-DSI');
      expect(chemin.chaineCertificats[3].sujet).toBe('AC-N1-RACINE');

      // Verify all signatures along the 4-link chain
      const certAC3 = chemin.chaineCertificats[1];
      const certAC2 = chemin.chaineCertificats[2];
      const certRoot = chemin.chaineCertificats[3];

      expect(verifyCertificatSignature(certAlice, certAC3.clePublique)).toBe(true);
      expect(verifyCertificatSignature(certAC3, certAC2.clePublique)).toBe(true);
      expect(verifyCertificatSignature(certAC2, certRoot.clePublique)).toBe(true);
      expect(verifyCertificatSignature(certRoot, certRoot.clePublique)).toBe(true);
    });

    it('should complete delegated keypair mode (genererBicle: true), return private key once, and neither AC nor AE retains it', async () => {
      const hierarchie = bootstrapHierarchieAc(broker);
      const annuaire = new ServicePublication(broker);
      annuaire.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

      const aeManager = bootstrapAutoritesEnregistrement(broker);
      const aeRouteurs = aeManager.getAeParNature('routeurs');

      // Register router entity attached to AC-N3-INFRA-RESEAU
      aeRouteurs.enregistrerEntite({
        nomEntite: 'routeur-core-01.infra.organisation.fr',
        motDePasse: 'RouterAuth#99',
        natureRessource: 'routeurs',
        droitSignature: true,
        droitChiffrement: false,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-INFRA-RESEAU',
      });

      // Submit certification request with genererBicle: true
      const resCreation = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/routeurs/demandes-certification',
        body: {
          nomEntite: 'routeur-core-01.infra.organisation.fr',
          motDePasse: 'RouterAuth#99',
          usage: 'SIGNATURE',
          genererBicle: true,
        },
      });

      expect(resCreation.status).toBe(201);
      const bodyReponse = resCreation.body as DemandeCertificationReponse;
      expect(bodyReponse.statutDemande).toBe('EMISE');
      expect(bodyReponse.clePriveeGeneree).toBeDefined();
      expect(bodyReponse.clePriveeGeneree).toContain('-----BEGIN PRIVATE KEY-----');

      const certRouteur = bodyReponse.certificat!;
      expect(certRouteur.sujet).toBe('routeur-core-01.infra.organisation.fr');
      expect(certRouteur.identifiantAcEmettrice).toBe('AC-N3-INFRA-RESEAU');
      expect(certRouteur.usage).toBe('SIGNATURE');

      // Verify the generated private key can produce a signature verifiable by the cert's public key
      const testData = Buffer.from('Test router authentication payload', 'utf-8');
      const signer = crypto.createSign('SHA256');
      signer.update(testData);
      signer.end();
      const signature = signer.sign(bodyReponse.clePriveeGeneree!, 'base64');

      const verifier = crypto.createVerify('SHA256');
      verifier.update(testData);
      verifier.end();
      const isValid = verifier.verify(
        base64ToPublicKeyPem(certRouteur.clePublique),
        signature,
        'base64'
      );
      expect(isValid).toBe(true);

      // Verify that AE does NOT store the private key in GET /ae/{nature}/demandes-certification/{demandeId}
      const resGetDemande = await aeManager.handleRequest({
        method: 'GET',
        path: `/ae/routeurs/demandes-certification/${bodyReponse.demandeId}`,
      });
      expect(resGetDemande.status).toBe(200);
      const getBody = resGetDemande.body as DemandeCertificationReponse;
      expect(getBody.clePriveeGeneree).toBeNull();

      // Verify that AC does NOT store private keys anywhere
      const acN3Reseau = hierarchie.allAcs.find((ac) => ac.id === 'AC-N3-INFRA-RESEAU')!;
      expect(JSON.stringify(acN3Reseau)).not.toContain(bodyReponse.clePriveeGeneree);
    });
  });
});


