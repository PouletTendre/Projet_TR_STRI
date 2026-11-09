import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import { bootstrapHierarchieAc } from '../src/ac/index.js';
import { ServicePublication } from '../src/annuaire/index.js';
import {
  AutoriteValidation,
  ServiceAutoriteValidation,
  bootstrapAutoritesValidation,
} from '../src/av/index.js';
import {
  generateRsaKeyPair,
  decryptChatMessage,
} from '../src/crypto/index.js';
import {
  CorrespondantClient,
  CertificateValidationError,
  SignatureVerificationError,
  CertificateStatusError,
  DecryptionError,
} from '../src/chat/index.js';

describe('Sécurisation cryptographique des Échanges de Messagerie (Ticket #7)', () => {
  let broker: InMemoryJmsBroker;
  let hierarchie: ReturnType<typeof bootstrapHierarchieAc>;
  let annuaire: ServicePublication;
  let avManager: ServiceAutoriteValidation;
  let avMessagerie: AutoriteValidation;

  beforeEach(() => {
    broker = new InMemoryJmsBroker();
    hierarchie = bootstrapHierarchieAc(broker);
    annuaire = new ServicePublication(broker);
    annuaire.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    avManager = bootstrapAutoritesValidation(broker, annuaire);
    avMessagerie = avManager.getAvParNature('messagerie');
  });

  function creerCertificatPorteur(params: {
    sujet: string;
    usage: 'SIGNATURE' | 'CHIFFREMENT' | 'SIGNATURE_ET_CHIFFREMENT';
    clePubliqueBase64: string;
    numeroSerie?: string;
    dateDebutValidite?: string;
    dateFinValidite?: string;
  }) {
    const acN3 = hierarchie.acsNiveau3.find(
      (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
    )!;
    return acN3.signerCertificat({
      numeroSerie: params.numeroSerie ?? `SN-TEST-${Date.now()}-${Math.random()}`,
      sujet: params.sujet,
      clePublique: params.clePubliqueBase64,
      usage: params.usage,
      natureRessource: 'messagerie',
      dateDebutValidite: params.dateDebutValidite,
      dateFinValidite: params.dateFinValidite,
    });
  }

  describe('Validation AV préalable (Pre-flight) avant INIT_ECHANGE', () => {
    it('should reject INIT_ECHANGE when recipient certificate is missing from Annuaire and NOT publish to JMS', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-PREFLIGHT-01',
      });

      let publishedCount = 0;
      const originalSend = broker.sendToQueue.bind(broker);
      broker.sendToQueue = (q, input) => {
        publishedCount++;
        originalSend(q, input);
      };

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      // Bob has no certificate published in Annuaire
      expect(() => {
        alice.initialiserEchange('bob-sans-cert@dsi.fr', {
          niveauSecurite: 'SIGNE',
          premierMessage: 'Tentative sans cert destinataire',
        });
      }).toThrow(CertificateValidationError);

      // Verify no message was published to JMS
      expect(publishedCount).toBe(0);
    });

    it('should reject INIT_ECHANGE when recipient certificate is expired (Step 1)', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-PREFLIGHT-02',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBobExpired = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-EXPIRED-01',
        dateDebutValidite: '2024-01-01T00:00:00Z',
        dateFinValidite: '2024-12-31T23:59:59Z',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      expect(() => {
        alice.initialiserEchange('bob@dsi.fr', {
          niveauSecurite: 'SIGNE',
          destinataireCertificatNumeroSerie: certBobExpired.numeroSerie,
          premierMessage: 'Pre-flight Bob expiré',
        });
      }).toThrow(CertificateValidationError);
    });

    it('should reject INIT_ECHANGE when recipient certificate is SUSPENDU or REVOQUE (Step 3)', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-PREFLIGHT-03',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBob = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-SUSPENDU-01',
      });

      // Suspend Bob's certificate in AV
      avMessagerie.mettreAJourStatut(certBob.numeroSerie, 'SUSPENDU', 'Audit de sécurité');

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      expect(() => {
        alice.initialiserEchange('bob@dsi.fr', {
          niveauSecurite: 'CHIFFRE',
          premierMessage: 'Pre-flight Bob suspendu',
        });
      }).toThrow(CertificateValidationError);

      // Now revoke Bob's certificate
      avMessagerie.mettreAJourStatut(certBob.numeroSerie, 'REVOQUE', 'Compromission clé');

      expect(() => {
        alice.initialiserEchange('bob@dsi.fr', {
          niveauSecurite: 'CHIFFRE',
          premierMessage: 'Pre-flight Bob révoqué',
        });
      }).toThrow(CertificateValidationError);
    });

    it('should reject INIT_ECHANGE when recipient lacks required key usage (Step 4)', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-PREFLIGHT-04',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBobSignatureOnly = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE', // ONLY signature, not chiffrement
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-SIG-ONLY',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      // Alice requests CHIFFRE mode, but Bob only has SIGNATURE usage
      expect(() => {
        alice.initialiserEchange('bob@dsi.fr', {
          niveauSecurite: 'CHIFFRE',
          destinataireCertificatNumeroSerie: certBobSignatureOnly.numeroSerie,
          premierMessage: 'Usage incompatible',
        });
      }).toThrow(CertificateValidationError);
    });

    it('should reject INIT_ECHANGE when sender certificate is revoked or invalid', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-REVOKED',
      });

      const bobKeyPair = generateRsaKeyPair();
      creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-VALID-01',
      });

      // Alice's own certificate is revoked
      avMessagerie.mettreAJourStatut(certAlice.numeroSerie, 'REVOQUE', 'Révocation administrative');

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      expect(() => {
        alice.initialiserEchange('bob@dsi.fr', {
          niveauSecurite: 'SIGNE',
          premierMessage: 'Alice révoquée tente d initialiser',
        });
      }).toThrow(CertificateValidationError);
    });
  });

  describe('Mode SIGNE : Intégrité, Authenticité et Rejet des Altérations', () => {
    it('should open and exchange signed messages with verified digital signatures', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-SIG-01',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBob = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-SIG-01',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      const bob = new CorrespondantClient({
        id: 'bob@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certBob.numeroSerie,
        clePriveePem: bobKeyPair.privateKeyPem,
      });

      const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
        niveauSecurite: 'SIGNE',
        premierMessage: 'Ordre de virement: 500€',
      });

      const sessionBob = bob.getEchange(sessionAlice.echangeId);
      expect(sessionBob).toBeDefined();
      expect(sessionBob?.etat).toBe('ACTIF');
      expect(sessionBob?.niveauSecurite).toBe('SIGNE');

      // Bob's received message has valid text and signature
      const premierMsgBob = sessionBob?.messages[0];
      expect(premierMsgBob?.texte).toBe('Ordre de virement: 500€');
      expect(premierMsgBob?.signature).toBeDefined();
      expect(premierMsgBob?.numeroSerieCertExpediteur).toBe(certAlice.numeroSerie);

      // Bob replies with a signed message
      bob.envoyerMessage(sessionAlice.echangeId, 'Accusé réception 500€');

      const deuxiemeMsgAlice = alice.getHistorique(sessionAlice.echangeId)[1];
      expect(deuxiemeMsgAlice.texte).toBe('Accusé réception 500€');
      expect(deuxiemeMsgAlice.signature).toBeDefined();
      expect(deuxiemeMsgAlice.numeroSerieCertExpediteur).toBe(certBob.numeroSerie);
    });

    it('should reject tampered message body on the queue with SignatureVerificationError', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-SIG-TAMPER',
      });

      const bobKeyPair = generateRsaKeyPair();
      creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-SIG-TAMPER',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      const bob = new CorrespondantClient({
        id: 'bob@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: 'SN-BOB-SIG-TAMPER',
        clePriveePem: bobKeyPair.privateKeyPem,
      });

      const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
        niveauSecurite: 'SIGNE',
        premierMessage: 'Message initial intègre',
      });

      // An attacker intercepts and attempts to forge or alter sequence 2 into Bob's inbox
      expect(() => {
        broker.sendToQueue('queue.chat.inbox.bob@dsi.fr', {
          headers: {
            JMSCorrelationID: sessionAlice.echangeId,
            echange_id: sessionAlice.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE',
            expediteur_id: 'alice@dsi.fr',
            destinataire_id: 'bob@dsi.fr',
            numero_serie_cert_expediteur: certAlice.numeroSerie,
            numero_sequence: 2,
            horodatage: new Date().toISOString(),
            signature: 'FAUSSE_SIGNATURE_FORGEE_BASE64==',
          },
          payload: {
            chargeUtile: {
              contenuTexte: 'Montant modifié: 50 000€',
              signatureExpediteur: 'FAUSSE_SIGNATURE_FORGEE_BASE64==',
              numeroSerieCertExpediteur: certAlice.numeroSerie,
            },
          },
        });
      }).toThrow(SignatureVerificationError);

      // Verify Bob's history did NOT accept the tampered message
      expect(bob.getHistorique(sessionAlice.echangeId).length).toBe(1);
    });
  });

  describe('Mode CHIFFRE : Confidentialité bout-en-bout', () => {
    it('should encrypt message on the wire and decrypt properly on recipient side', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-ENC-01',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBob = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'CHIFFREMENT',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-ENC-01',
      });

      let capturedRawMessage: any = null;
      const originalSend = broker.sendToQueue.bind(broker);
      broker.sendToQueue = (q, input) => {
        capturedRawMessage = input;
        originalSend(q, input);
      };

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      const bob = new CorrespondantClient({
        id: 'bob@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certBob.numeroSerie,
        clePriveePem: bobKeyPair.privateKeyPem,
      });

      const secretText = 'Données strictement confidentielles : Projet X';
      const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
        niveauSecurite: 'CHIFFRE',
        premierMessage: secretText,
      });

      // 1. Check raw JMS message on the wire
      expect(capturedRawMessage).not.toBeNull();
      const rawWireBody =
        typeof capturedRawMessage.payload === 'string'
          ? capturedRawMessage.payload
          : JSON.stringify(capturedRawMessage.payload);
      expect(rawWireBody).not.toContain(secretText);
      expect(capturedRawMessage.payload.chargeUtile.contenuTexte).not.toBe(secretText);
      expect(capturedRawMessage.payload.chargeUtile.cleSessionChiffreeCpDestinataire).toBeDefined();

      // 2. Check Bob decrypted the text cleanly
      const sessionBob = bob.getEchange(sessionAlice.echangeId);
      expect(sessionBob?.messages[0].texte).toBe(secretText);

      // 3. Verify an eavesdropper cannot decrypt without Bob's private key
      const eavesdropperKeyPair = generateRsaKeyPair();
      expect(() => {
        decryptChatMessage(
          capturedRawMessage.payload.chargeUtile,
          eavesdropperKeyPair.privateKeyPem
        );
      }).toThrow();
    });
  });

  describe('Mode SIGNE_ET_CHIFFRE : Confidentialité, Authenticité et Clôture FIN_MSG', () => {
    it('should work with combined single certificate (SIGNATURE_ET_CHIFFREMENT)', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-COMBINED',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBob = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-COMBINED',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      const bob = new CorrespondantClient({
        id: 'bob@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certBob.numeroSerie,
        clePriveePem: bobKeyPair.privateKeyPem,
      });

      const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
        niveauSecurite: 'SIGNE_ET_CHIFFRE',
        premierMessage: 'Message secret et authentifié',
      });

      const sessionBob = bob.getEchange(sessionAlice.echangeId);
      expect(sessionBob?.etat).toBe('ACTIF');
      expect(sessionBob?.niveauSecurite).toBe('SIGNE_ET_CHIFFRE');
      expect(sessionBob?.messages[0].texte).toBe('Message secret et authentifié');
      expect(sessionBob?.messages[0].signature).toBeDefined();

      // Bob replies
      bob.envoyerMessage(sessionAlice.echangeId, 'Réponse confidentielle');
      expect(alice.getHistorique(sessionAlice.echangeId)[1].texte).toBe('Réponse confidentielle');

      // Alice cleanly closes with FIN_MSG
      alice.cloreEchange(sessionAlice.echangeId);

      expect(alice.getEchange(sessionAlice.echangeId)?.etat).toBe('TERMINE');
      expect(bob.getEchange(sessionAlice.echangeId)?.etat).toBe('TERMINE');

      const dernierMsgAlice = alice.getHistorique(sessionAlice.echangeId).slice(-1)[0];
      const dernierMsgBob = bob.getHistorique(sessionAlice.echangeId).slice(-1)[0];

      expect(dernierMsgAlice.typeMessage).toBe('FIN_MSG');
      expect(dernierMsgAlice.texte).toBe('FIN_MSG');
      expect(dernierMsgBob.typeMessage).toBe('FIN_MSG');
      expect(dernierMsgBob.texte).toBe('FIN_MSG');
    });

    it('should support distinct certificates for signature and encryption', () => {
      // Alice: distinct keypairs & certs
      const aliceSigKeyPair = generateRsaKeyPair();
      const certAliceSig = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE',
        clePubliqueBase64: aliceSigKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-DISTINCT-SIG',
      });

      const aliceEncKeyPair = generateRsaKeyPair();
      const certAliceEnc = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'CHIFFREMENT',
        clePubliqueBase64: aliceEncKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-DISTINCT-ENC',
      });

      // Bob: distinct keypairs & certs
      const bobSigKeyPair = generateRsaKeyPair();
      const certBobSig = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE',
        clePubliqueBase64: bobSigKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-DISTINCT-SIG',
      });

      const bobEncKeyPair = generateRsaKeyPair();
      const certBobEnc = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'CHIFFREMENT',
        clePubliqueBase64: bobEncKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-DISTINCT-ENC',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAliceSig.numeroSerie,
        clePriveePem: aliceSigKeyPair.privateKeyPem,
        certificatChiffrementNumeroSerie: certAliceEnc.numeroSerie,
        clePriveeChiffrementPem: aliceEncKeyPair.privateKeyPem,
      });

      const bob = new CorrespondantClient({
        id: 'bob@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certBobSig.numeroSerie,
        clePriveePem: bobSigKeyPair.privateKeyPem,
        certificatChiffrementNumeroSerie: certBobEnc.numeroSerie,
        clePriveeChiffrementPem: bobEncKeyPair.privateKeyPem,
      });

      const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
        niveauSecurite: 'SIGNE_ET_CHIFFRE',
        premierMessage: 'Distinct certs exchange init',
      });

      const sessionBob = bob.getEchange(sessionAlice.echangeId);
      expect(sessionBob?.etat).toBe('ACTIF');
      expect(sessionBob?.messages[0].texte).toBe('Distinct certs exchange init');

      bob.envoyerMessage(sessionAlice.echangeId, 'Distinct certs Bob reply');
      expect(alice.getHistorique(sessionAlice.echangeId)[1].texte).toBe('Distinct certs Bob reply');

      bob.cloreEchange(sessionAlice.echangeId);
      expect(alice.getEchange(sessionAlice.echangeId)?.etat).toBe('TERMINE');
      expect(bob.getEchange(sessionAlice.echangeId)?.etat).toBe('TERMINE');
    });
  });

  describe('Contrôle dynamique du statut de certificat en cours d\'échange', () => {
    it('should reject incoming messages with CertificateStatusError when sender certificate is SUSPENDU mid-session', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-DYN-REVOKE',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBob = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-DYN-REVOKE',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      const bob = new CorrespondantClient({
        id: 'bob@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certBob.numeroSerie,
        clePriveePem: bobKeyPair.privateKeyPem,
      });

      const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
        niveauSecurite: 'SIGNE',
        premierMessage: 'Message 1 valide',
      });

      bob.envoyerMessage(sessionAlice.echangeId, 'Message 2 valide');

      // Mid-session security alert: Alice's certificate is suspended by AV
      avMessagerie.mettreAJourStatut(
        certAlice.numeroSerie,
        'SUSPENDU',
        'Suspicion de fuite de clé'
      );

      // Alice tries to send message 3: Bob's queue consumer should reject it dynamically
      expect(() => {
        alice.envoyerMessage(sessionAlice.echangeId, 'Message 3 après suspension');
      }).toThrow(CertificateStatusError);

      // Verify Bob's history still only has 2 messages
      expect(bob.getHistorique(sessionAlice.echangeId).length).toBe(2);

      // If Alice's certificate is reactivated by AV
      avMessagerie.mettreAJourStatut(certAlice.numeroSerie, 'VALIDE');

      // Now message 3 succeeds
      alice.envoyerMessage(sessionAlice.echangeId, 'Message 3 réactivé');
      expect(bob.getHistorique(sessionAlice.echangeId).length).toBe(3);
      expect(bob.getHistorique(sessionAlice.echangeId)[2].texte).toBe('Message 3 réactivé');
    });

    it('should reject incoming messages when sender certificate is permanently REVOQUE mid-session', () => {
      const aliceKeyPair = generateRsaKeyPair();
      const certAlice = creerCertificatPorteur({
        sujet: 'alice@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: aliceKeyPair.publicKeyBase64,
        numeroSerie: 'SN-ALICE-PERM-REVOKE',
      });

      const bobKeyPair = generateRsaKeyPair();
      const certBob = creerCertificatPorteur({
        sujet: 'bob@dsi.fr',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePubliqueBase64: bobKeyPair.publicKeyBase64,
        numeroSerie: 'SN-BOB-PERM-REVOKE',
      });

      const alice = new CorrespondantClient({
        id: 'alice@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certAlice.numeroSerie,
        clePriveePem: aliceKeyPair.privateKeyPem,
      });

      const bob = new CorrespondantClient({
        id: 'bob@dsi.fr',
        broker,
        annuaire,
        av: avMessagerie,
        certificatNumeroSerie: certBob.numeroSerie,
        clePriveePem: bobKeyPair.privateKeyPem,
      });

      const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
        niveauSecurite: 'SIGNE_ET_CHIFFRE',
        premierMessage: 'Message 1 valide avant révocation',
      });

      // Admin revokes Alice's certificate permanently
      avMessagerie.mettreAJourStatut(
        certAlice.numeroSerie,
        'REVOQUE',
        'Révocation définitive'
      );

      // Next message rejected
      expect(() => {
        alice.envoyerMessage(sessionAlice.echangeId, 'Message 2 bloqué');
      }).toThrow(CertificateStatusError);
    });
  });
});
