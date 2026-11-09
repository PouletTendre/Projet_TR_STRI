import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import {
  bootstrapHierarchieAc,
  AutoriteCertification,
} from '../src/ac/index.js';
import { ServicePublication } from '../src/annuaire/index.js';
import {
  generateRsaKeyPair,
  signCertificat,
} from '../src/crypto/index.js';
import {
  AutoriteValidation,
  ServiceAutoriteValidation,
  bootstrapAutoritesValidation,
} from '../src/av/index.js';
import type {
  Certificat,
  StatutCertificatReponse,
  ValidationCertificatReponse,
  ErreurApi,
} from '../src/types/index.js';

describe('Autorité de Validation (AV) & 4-Step Validation Contract', () => {
  let broker: InMemoryJmsBroker;
  let annuaire: ServicePublication;
  let hierarchie: ReturnType<typeof bootstrapHierarchieAc>;
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

  describe('Contrôle de statut unitaire (GET /av/{nature}/certificats/{numeroSerie}/statut)', () => {
    it('should return VALIDE for an issued certificate published on broker', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      const certPorteur = acN3.signerCertificat({
        numeroSerie: 'SN-2026-TEST-VALID-01',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        natureRessource: 'messagerie',
      });

      const res = avManager.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certPorteur.numeroSerie}/statut`,
      }) as { status: number; body: StatutCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.numeroSerie).toBe('SN-2026-TEST-VALID-01');
      expect(res.body.statut).toBe('VALIDE');
      expect(res.body.identifiantAcEmettrice).toBe('AC-N3-DSI-MESSAGERIE');
      expect(res.body.identifiantAv).toBe('AV-MESSAGERIE');
      expect(res.body.motifInvalidation).toBeNull();
      expect(res.body.dateInvalidation).toBeNull();
      expect(res.body.horodatageVerification).toBeDefined();
    });

    it('should return INCONNU for an unknown certificate serial number', () => {
      const res = avManager.handleRequest({
        method: 'GET',
        path: '/av/messagerie/certificats/SN-UNKNOWN-999999/statut',
      }) as { status: number; body: StatutCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.numeroSerie).toBe('SN-UNKNOWN-999999');
      expect(res.body.statut).toBe('INCONNU');
      expect(res.body.identifiantAv).toBe('AV-MESSAGERIE');
    });

    it('should update certificate status to SUSPENDU, REVOQUE, and back to VALIDE via LCR publication topic', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      const certPorteur = acN3.signerCertificat({
        numeroSerie: 'SN-2026-LCR-TEST-01',
        sujet: 'bob.test@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
        natureRessource: 'messagerie',
      });

      // 1. Initially VALIDE
      let res = avManager.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certPorteur.numeroSerie}/statut`,
      }) as { status: number; body: StatutCertificatReponse };
      expect(res.body.statut).toBe('VALIDE');

      // 2. Publish suspension to topic.pki.publications.lcr
      broker.publish('topic.pki.publications.lcr', {
        headers: {
          type_message: 'PUBLICATION_LCR',
          ac_emettrice_id: 'AC-N3-DSI-MESSAGERIE',
          numero_serie_affecte: certPorteur.numeroSerie,
          nouveau_statut: 'SUSPENDU',
        },
        payload: {
          identifiantAc: 'AC-N3-DSI-MESSAGERIE',
          evenementDeclencheur: {
            numeroSerieCertificat: certPorteur.numeroSerie,
            action: 'SUSPENSION',
            nouveauStatut: 'SUSPENDU',
            motif: 'SUSPENSION_TEMPORAIRE',
            dateEffet: new Date().toISOString(),
          },
        },
      });

      res = avManager.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certPorteur.numeroSerie}/statut`,
      }) as { status: number; body: StatutCertificatReponse };
      expect(res.body.statut).toBe('SUSPENDU');
      expect(res.body.motifInvalidation).toBe('SUSPENSION_TEMPORAIRE');
      expect(res.body.dateInvalidation).toBeDefined();

      // 3. Reactivate certificate
      broker.publish('topic.pki.publications.lcr', {
        headers: {
          type_message: 'PUBLICATION_LCR',
          ac_emettrice_id: 'AC-N3-DSI-MESSAGERIE',
          numero_serie_affecte: certPorteur.numeroSerie,
          nouveau_statut: 'VALIDE',
        },
        payload: {
          identifiantAc: 'AC-N3-DSI-MESSAGERIE',
          evenementDeclencheur: {
            numeroSerieCertificat: certPorteur.numeroSerie,
            action: 'REACTIVATION',
            nouveauStatut: 'VALIDE',
            motif: 'FIN_SUSPENSION',
            dateEffet: new Date().toISOString(),
          },
        },
      });

      res = avManager.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certPorteur.numeroSerie}/statut`,
      }) as { status: number; body: StatutCertificatReponse };
      expect(res.body.statut).toBe('VALIDE');
      expect(res.body.motifInvalidation).toBeNull();

      // 4. Revoke certificate definitively
      broker.publish('topic.pki.publications.lcr', {
        headers: {
          type_message: 'PUBLICATION_LCR',
          ac_emettrice_id: 'AC-N3-DSI-MESSAGERIE',
          numero_serie_affecte: certPorteur.numeroSerie,
          nouveau_statut: 'REVOQUE',
        },
        payload: {
          identifiantAc: 'AC-N3-DSI-MESSAGERIE',
          evenementDeclencheur: {
            numeroSerieCertificat: certPorteur.numeroSerie,
            action: 'REVOCATION',
            nouveauStatut: 'REVOQUE',
            motif: 'COMPROMISSION_CLE_PRIVEE',
            dateEffet: new Date().toISOString(),
          },
        },
      });

      res = avManager.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certPorteur.numeroSerie}/statut`,
      }) as { status: number; body: StatutCertificatReponse };
      expect(res.body.statut).toBe('REVOQUE');
      expect(res.body.motifInvalidation).toBe('COMPROMISSION_CLE_PRIVEE');
    });

    it('should return 404 when querying an unsupported nature', () => {
      const res = avManager.handleRequest({
        method: 'GET',
        path: '/av/invalide_nature/certificats/SN-01/statut',
      }) as { status: number; body: ErreurApi };

      expect(res.status).toBe(404);
      expect(res.body.code).toBe('NATURE_RESSOURCE_INVALIDE');
    });
  });

  describe('Validation complète en 4 étapes (POST /av/{nature}/validations)', () => {
    it('should validate a legitimate certificate with all 4 steps succeeding and return detailed chain', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      const certPorteur = acN3.signerCertificat({
        numeroSerie: 'SN-2026-DSI-000142',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        natureRessource: 'messagerie',
      });

      const res = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certPorteur.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: 'alice.martin@dsi.organisation.fr',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.valide).toBe(true);
      expect(res.body.numeroSerieCertificat).toBe(certPorteur.numeroSerie);
      expect(res.body.statutCourant).toBe('VALIDE');
      expect(res.body.detailsEtapes.etape1PeriodeValiditeOk).toBe(true);
      expect(res.body.detailsEtapes.etape2SignatureEtCheminOk).toBe(true);
      expect(res.body.detailsEtapes.etape3StatutAvOk).toBe(true);
      expect(res.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(true);
      expect(res.body.detailsEtapes.messageDiagnostic).toBeDefined();

      // Check certification path contains all 4 levels: Porteur -> N3 -> N2 -> N1
      expect(res.body.cheminCertification).toHaveLength(4);
      expect(res.body.cheminCertification[0]).toContain(certPorteur.numeroSerie);
      expect(res.body.cheminCertification[0]).toContain('alice.martin@dsi.organisation.fr');
      expect(res.body.cheminCertification[1]).toContain('AC-N3-DSI-MESSAGERIE');
      expect(res.body.cheminCertification[2]).toContain('AC-N2-DSI');
      expect(res.body.cheminCertification[3]).toContain('AC-N1-RACINE');
      expect(res.body.cheminCertification[3]).toContain('Auto-signé');
    });

    it('should fail Step 1 if target certificate is expired', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      // Certificate expired in the past
      const certExpire = acN3.signerCertificat({
        numeroSerie: 'SN-2026-EXPIRED-01',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
        dateDebutValidite: '2020-01-01T00:00:00Z',
        dateFinValidite: '2021-01-01T00:00:00Z',
      });

      const res = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certExpire.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.valide).toBe(false);
      expect(res.body.detailsEtapes.etape1PeriodeValiditeOk).toBe(false);
      expect(res.body.detailsEtapes.etape2SignatureEtCheminOk).toBe(true);
      expect(res.body.detailsEtapes.etape3StatutAvOk).toBe(true);
      expect(res.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(true);
    });

    it('should fail Step 1 if target certificate validity start is in the future', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      const certFutur = acN3.signerCertificat({
        numeroSerie: 'SN-2026-FUTURE-01',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
        dateDebutValidite: '2030-01-01T00:00:00Z',
        dateFinValidite: '2031-01-01T00:00:00Z',
      });

      const res = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certFutur.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.valide).toBe(false);
      expect(res.body.detailsEtapes.etape1PeriodeValiditeOk).toBe(false);
    });

    it('should fail Step 2 if certificate signature is altered or forged', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      const certOriginal = acN3.signerCertificat({
        numeroSerie: 'SN-2026-FORGED-01',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
      });

      // Tamper with signature
      const certAltere: Certificat = {
        ...certOriginal,
        signatureAc: Buffer.from('fausse_signature_alteree').toString('base64'),
      };
      // Re-publish to Annuaire
      annuaire.onCertificatPublie({
        headers: { type_message: 'PUBLICATION_CERTIFICAT' },
        body: JSON.stringify(certAltere),
        payload: certAltere,
      });

      const res = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certAltere.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.valide).toBe(false);
      expect(res.body.detailsEtapes.etape2SignatureEtCheminOk).toBe(false);
    });

    it('should fail Step 2 if intermediate CA certificate is missing usage CERTIFICATION_AC', () => {
      // Create a rogue intermediate CA with usage SIGNATURE
      const rootAc = hierarchie.acRacine;
      const rogueKeyPair = generateRsaKeyPair();
      const rogueCert = rootAc.signerCertificat({
        numeroSerie: 'SN-AC-ROGUE',
        sujet: 'AC-N2-ROGUE',
        clePublique: rogueKeyPair.publicKeyBase64,
        usage: 'SIGNATURE', // Not CERTIFICATION_AC!
      });

      const rogueAc = new AutoriteCertification({
        id: 'AC-N2-ROGUE',
        nomOrganisationnel: 'Rogue CA',
        niveau: 2,
        acParenteId: rootAc.id,
        keyPair: rogueKeyPair,
        certificat: rogueCert,
        broker,
      });
      annuaire.enregistrerAutorite(rogueAc.getInfo());

      const clientKeyPair = generateRsaKeyPair();
      const leafCert = rogueAc.signerCertificat({
        numeroSerie: 'SN-LEAF-ROGUE',
        sujet: 'victim@dsi.organisation.fr',
        clePublique: clientKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
      });

      const res = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: leafCert.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.valide).toBe(false);
      expect(res.body.detailsEtapes.etape2SignatureEtCheminOk).toBe(false);
    });

    it('should fail Step 3 if target certificate is unknown', () => {
      const res = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: 'SN-UNKNOWN-NOT-FOUND',
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.valide).toBe(false);
      expect(res.body.statutCourant).toBe('INCONNU');
      expect(res.body.detailsEtapes.etape3StatutAvOk).toBe(false);
    });

    it('should fail Step 3 if target certificate is SUSPENDU or REVOQUE', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      const certPorteur = acN3.signerCertificat({
        numeroSerie: 'SN-2026-REVOKED-01',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
      });

      // Mark certificate as REVOQUE
      avMessagerie.mettreAJourStatut(
        certPorteur.numeroSerie,
        'REVOQUE',
        'COMPROMISSION_CLE_PRIVEE'
      );

      const resRev = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certPorteur.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(resRev.status).toBe(200);
      expect(resRev.body.valide).toBe(false);
      expect(resRev.body.statutCourant).toBe('REVOQUE');
      expect(resRev.body.detailsEtapes.etape3StatutAvOk).toBe(false);

      // Change to SUSPENDU
      avMessagerie.mettreAJourStatut(
        certPorteur.numeroSerie,
        'SUSPENDU',
        'SUSPENSION_TEMPORAIRE'
      );

      const resSusp = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certPorteur.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(resSusp.status).toBe(200);
      expect(resSusp.body.valide).toBe(false);
      expect(resSusp.body.statutCourant).toBe('SUSPENDU');
      expect(resSusp.body.detailsEtapes.etape3StatutAvOk).toBe(false);
    });

    it('should fail Step 3 if an intermediate CA in the chain is SUSPENDU or REVOQUE', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      const certPorteur = acN3.signerCertificat({
        numeroSerie: 'SN-2026-LEAF-CA-REVOKED',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
      });

      // Revoke the intermediate N3 AC in the AV status store
      avMessagerie.mettreAJourStatut(
        acN3.certificat.numeroSerie,
        'REVOQUE',
        'CESSATION_ACTIVITE'
      );

      const res = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certPorteur.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };

      expect(res.status).toBe(200);
      expect(res.body.valide).toBe(false);
      expect(res.body.detailsEtapes.etape3StatutAvOk).toBe(false);
    });

    it('should enforce Key Usage and Subject policy in Step 4', () => {
      const acN3 = hierarchie.acsNiveau3.find(
        (ac) => ac.id === 'AC-N3-DSI-MESSAGERIE'
      )!;
      const porteurKeyPair = generateRsaKeyPair();

      // Certificate with SIGNATURE only
      const certSig = acN3.signerCertificat({
        numeroSerie: 'SN-2026-SIG-ONLY',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE',
      });

      // 1. SIGNATURE requested -> pass
      const resPass = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certSig.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };
      expect(resPass.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(true);
      expect(resPass.body.valide).toBe(true);

      // 2. CHIFFREMENT requested -> fail step 4
      const resFailChiff = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certSig.numeroSerie,
          usageAttendu: 'CHIFFREMENT',
        },
      }) as { status: number; body: ValidationCertificatReponse };
      expect(resFailChiff.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(false);
      expect(resFailChiff.body.valide).toBe(false);

      // 3. SIGNATURE_ET_CHIFFREMENT requested -> fail step 4
      const resFailBoth = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certSig.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
        },
      }) as { status: number; body: ValidationCertificatReponse };
      expect(resFailBoth.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(false);
      expect(resFailBoth.body.valide).toBe(false);

      // 4. Certificate with SIGNATURE_ET_CHIFFREMENT covers all individual operations
      const certBoth = acN3.signerCertificat({
        numeroSerie: 'SN-2026-BOTH-01',
        sujet: 'bob.dupont@dsi.organisation.fr',
        clePublique: porteurKeyPair.publicKeyBase64,
        usage: 'SIGNATURE_ET_CHIFFREMENT',
      });

      const resBothForSig = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certBoth.numeroSerie,
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ValidationCertificatReponse };
      expect(resBothForSig.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(true);
      expect(resBothForSig.body.valide).toBe(true);

      const resBothForChiff = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certBoth.numeroSerie,
          usageAttendu: 'CHIFFREMENT',
        },
      }) as { status: number; body: ValidationCertificatReponse };
      expect(resBothForChiff.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(true);
      expect(resBothForChiff.body.valide).toBe(true);

      // 5. sujetAttendu check: exact match passes, mismatch fails step 4
      const resMatchingSubject = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certBoth.numeroSerie,
          usageAttendu: 'SIGNATURE',
          sujetAttendu: 'bob.dupont@dsi.organisation.fr',
        },
      }) as { status: number; body: ValidationCertificatReponse };
      expect(resMatchingSubject.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(true);
      expect(resMatchingSubject.body.valide).toBe(true);

      const resMismatchedSubject = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: certBoth.numeroSerie,
          usageAttendu: 'SIGNATURE',
          sujetAttendu: 'mallory.eve@pirate.org',
        },
      }) as { status: number; body: ValidationCertificatReponse };
      expect(resMismatchedSubject.body.detailsEtapes.etape4PolitiqueUsageOk).toBe(false);
      expect(resMismatchedSubject.body.valide).toBe(false);
    });

    it('should return 400 when validation request body is missing required fields', () => {
      const resMissingSerie = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          usageAttendu: 'SIGNATURE',
        },
      }) as { status: number; body: ErreurApi };
      expect(resMissingSerie.status).toBe(400);
      expect(resMissingSerie.body.code).toBe('REQUETE_INVALIDE');

      const resMissingUsage = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: 'SN-01',
        },
      }) as { status: number; body: ErreurApi };
      expect(resMissingUsage.status).toBe(400);
      expect(resMissingUsage.body.code).toBe('REQUETE_INVALIDE');
    });
  });
});
