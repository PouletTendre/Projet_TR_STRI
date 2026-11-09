import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import { bootstrapHierarchieAc } from '../src/ac/index.js';
import { ServicePublication } from '../src/annuaire/index.js';
import {
  bootstrapAutoritesEnregistrement,
  type ServiceAutoriteEnregistrement,
} from '../src/ae/index.js';
import {
  AutoriteValidation,
  ServiceAutoriteValidation,
} from '../src/av/index.js';
import { verifyLcrSignature } from '../src/crypto/index.js';
import type {
  DemandeRevocationReponse,
  DemandeCertificationReponse,
  ListeCertificatsRevoques,
  StatutCertificatReponse,
  ValidationCertificatReponse,
  ErreurApi,
} from '../src/types/index.js';

describe('Ticket #5: Révocation, Suspension et Réactivation de Certificat avec diffusion temps réel de la LCR', () => {
  let broker: InMemoryJmsBroker;
  let hierarchie: ReturnType<typeof bootstrapHierarchieAc>;
  let annuaire: ServicePublication;
  let aeManager: ServiceAutoriteEnregistrement;
  let avManager: ServiceAutoriteValidation;

  beforeEach(async () => {
    broker = new InMemoryJmsBroker();
    hierarchie = bootstrapHierarchieAc(broker);
    annuaire = new ServicePublication(broker);
    annuaire.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    aeManager = bootstrapAutoritesEnregistrement(broker, annuaire);

    avManager = new ServiceAutoriteValidation(broker, annuaire);
    const avMessagerie = new AutoriteValidation({
      id: 'AV-MESSAGERIE',
      nature: 'messagerie',
      broker,
      annuaire,
    });
    avManager.enregistrerAv(avMessagerie);
  });

  describe('Contrôles de sécurité et authentification AE (POST /ae/{nature}/demandes-revocation)', () => {
    it('should return 401 on unauthenticated entity (wrong password or unregistered entity)', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Wrong password
      const resWrongPw = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'WrongPassword!',
          numeroSerieCertificat: 'SN-2026-DSI-000001',
          action: 'REVOCATION',
        },
      });
      expect(resWrongPw.status).toBe(401);
      const errPw = resWrongPw.body as ErreurApi;
      expect(errPw.code).toBe('NON_AUTHENTIFIE');

      // Unknown entity
      const resUnknown = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'inconnu@dsi.organisation.fr',
          motDePasse: 'SomePassword!',
          numeroSerieCertificat: 'SN-2026-DSI-000001',
          action: 'REVOCATION',
        },
      });
      expect(resUnknown.status).toBe(401);
      const errUnknown = resUnknown.body as ErreurApi;
      expect(errUnknown.code).toBe('NON_AUTHENTIFIE');
    });

    it('should return 403 when entity lacks droitDemandeRevocation', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'bob.dupont@dsi.organisation.fr',
        motDePasse: 'BobSecret2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: false, // Lacks revocation right
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const res = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'bob.dupont@dsi.organisation.fr',
          motDePasse: 'BobSecret2026!',
          numeroSerieCertificat: 'SN-2026-DSI-000001',
          action: 'REVOCATION',
        },
      });

      expect(res.status).toBe(403);
      const err = res.body as ErreurApi;
      expect(err.code).toBe('DROITS_INSUFFISANTS');
    });

    it('should return 404 if the target certificate does not exist', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const res = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: 'SN-2026-NON-EXISTENT-999',
          action: 'REVOCATION',
        },
      });

      expect(res.status).toBe(404);
      const err = res.body as ErreurApi;
      expect(err.code).toBe('CERTIFICAT_INTROUVABLE');
    });

    it('should return 403 if authenticated entity does not own the target certificate', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });
      aeMessagerie.enregistrerEntite({
        nomEntite: 'bob.dupont@dsi.organisation.fr',
        motDePasse: 'BobSecret2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Enroll Alice
      const resEnrollAlice = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          genererBicle: true,
        },
      });
      expect(resEnrollAlice.status).toBe(201);
      const certAlice = (resEnrollAlice.body as DemandeCertificationReponse).certificat!;

      // Bob tries to revoke Alice's certificate
      const resBobRevokeAlice = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'bob.dupont@dsi.organisation.fr',
          motDePasse: 'BobSecret2026!',
          numeroSerieCertificat: certAlice.numeroSerie,
          action: 'REVOCATION',
        },
      });

      expect(resBobRevokeAlice.status).toBe(403);
      const err = resBobRevokeAlice.body as ErreurApi;
      expect(err.code).toBe('DROITS_INSUFFISANTS');
    });

    it('should return 409 Conflict if operating on an already expired certificate', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Issue an expired certificate directly via AC
      const acN3 = hierarchie.acsNiveau3.find((ac) => ac.id === 'AC-N3-DSI-MESSAGERIE')!;
      const expiredCert = acN3.signerCertificat({
        numeroSerie: 'SN-2026-EXPIRED-001',
        sujet: 'alice.martin@dsi.organisation.fr',
        clePublique: 'dummyPublicKeyAlice',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        natureRessource: 'messagerie',
        dateDebutValidite: new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString(),
        dateFinValidite: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(),
      });

      const res = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: expiredCert.numeroSerie,
          action: 'REVOCATION',
        },
      });

      expect(res.status).toBe(409);
      const err = res.body as ErreurApi;
      expect(err.code).toBe('TRANSITION_INVALIDE');
    });
  });

  describe('Cycle de vie complet : Suspension, Réactivation, Révocation et diffusion temps réel', () => {
    it('should support SUSPENSION: publish LCR update and fail AV Step 3 immediately', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const resEnroll = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          genererBicle: true,
        },
      });
      const cert = (resEnroll.body as DemandeCertificationReponse).certificat!;

      // Initial validation: should be valid
      let resVal = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: cert.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: 'alice.martin@dsi.organisation.fr',
        },
      });
      expect(resVal.status).toBe(200);
      expect((resVal.body as ValidationCertificatReponse).valide).toBe(true);
      expect((resVal.body as ValidationCertificatReponse).detailsEtapes.etape3StatutAvOk).toBe(true);

      // Perform SUSPENSION
      const resSuspend = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: cert.numeroSerie,
          action: 'SUSPENSION',
          motif: 'SUSPENSION_TEMPORAIRE',
        },
      });

      expect(resSuspend.status).toBe(200);
      const reponseSuspend = resSuspend.body as DemandeRevocationReponse;
      expect(reponseSuspend.actionAppliquee).toBe('SUSPENSION');
      expect(reponseSuspend.nouvelEtatCertificat).toBe('SUSPENDU');
      expect(reponseSuspend.numeroSerieCertificat).toBe(cert.numeroSerie);
      expect(reponseSuspend.horodatagePublicationLcr).toBeDefined();

      // AV unit status check should immediately reflect SUSPENDU
      const resStatut = avManager.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${cert.numeroSerie}/statut`,
      });
      expect(resStatut.status).toBe(200);
      expect((resStatut.body as StatutCertificatReponse).statut).toBe('SUSPENDU');

      // Full 4-step validation should now FAIL at Step 3
      resVal = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: cert.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: 'alice.martin@dsi.organisation.fr',
        },
      });
      expect(resVal.status).toBe(200);
      const valReponse = resVal.body as ValidationCertificatReponse;
      expect(valReponse.valide).toBe(false);
      expect(valReponse.detailsEtapes.etape3StatutAvOk).toBe(false);
    });

    it('should support REACTIVATION of a suspended cert: removes from LCR, restores VALIDE, and passes AV Step 3', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const resEnroll = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          genererBicle: true,
        },
      });
      const cert = (resEnroll.body as DemandeCertificationReponse).certificat!;

      // 1. Suspend
      await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: cert.numeroSerie,
          action: 'SUSPENSION',
        },
      });

      // 2. Reactivate
      const resReactivate = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: cert.numeroSerie,
          action: 'REACTIVATION',
          motif: 'FIN_SUSPENSION',
        },
      });

      expect(resReactivate.status).toBe(200);
      const reponseReactivate = resReactivate.body as DemandeRevocationReponse;
      expect(reponseReactivate.actionAppliquee).toBe('REACTIVATION');
      expect(reponseReactivate.nouvelEtatCertificat).toBe('VALIDE');

      // AV unit status check should be VALIDE
      const resStatut = avManager.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${cert.numeroSerie}/statut`,
      });
      expect(resStatut.status).toBe(200);
      expect((resStatut.body as StatutCertificatReponse).statut).toBe('VALIDE');

      // Full 4-step validation should PASS
      const resVal = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: cert.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: 'alice.martin@dsi.organisation.fr',
        },
      });
      expect(resVal.status).toBe(200);
      const valReponse = resVal.body as ValidationCertificatReponse;
      expect(valReponse.valide).toBe(true);
      expect(valReponse.detailsEtapes.etape3StatutAvOk).toBe(true);
    });

    it('should permanently REVOKE certificate, and reject subsequent reactivation with 409 Conflict', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const resEnroll = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          genererBicle: true,
        },
      });
      const cert = (resEnroll.body as DemandeCertificationReponse).certificat!;

      // Revoke definitively
      const resRevoke = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: cert.numeroSerie,
          action: 'REVOCATION',
          motif: 'COMPROMISSION_CLE_PRIVEE',
        },
      });

      expect(resRevoke.status).toBe(200);
      const reponseRevoke = resRevoke.body as DemandeRevocationReponse;
      expect(reponseRevoke.actionAppliquee).toBe('REVOCATION');
      expect(reponseRevoke.nouvelEtatCertificat).toBe('REVOQUE');

      // Attempt to reactivate: must be rejected with 409 Conflict (revocation is irreversible)
      const resReactivate = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: cert.numeroSerie,
          action: 'REACTIVATION',
        },
      });

      expect(resReactivate.status).toBe(409);
      const err = resReactivate.body as ErreurApi;
      expect(err.code).toBe('TRANSITION_INVALIDE');

      // Attempt to suspend already revoked cert: also 409
      const resSuspend = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: cert.numeroSerie,
          action: 'SUSPENSION',
        },
      });
      expect(resSuspend.status).toBe(409);
    });

    it('should fail AV Step 3 for all subordinate certificates when an intermediate CA is revoked', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      // Issue certificate for Alice under AC-N3-DSI-MESSAGERIE
      const resEnroll = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          genererBicle: true,
        },
      });
      const cert = (resEnroll.body as DemandeCertificationReponse).certificat!;

      // Validate Alice prior to intermediate CA revocation
      let resVal = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: cert.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: 'alice.martin@dsi.organisation.fr',
        },
      });
      expect(resVal.status).toBe(200);
      expect((resVal.body as ValidationCertificatReponse).valide).toBe(true);

      // Now revoke the intermediate CA (AC-N2-DSI) by the root CA AC-N1-RACINE
      const acN2 = hierarchie.acsNiveau2.find((ac) => ac.id === 'AC-N2-DSI')!;
      hierarchie.acRacine.revoquerCertificat(
        acN2.certificat.numeroSerie,
        'COMPROMISSION_CLE_PRIVEE'
      );

      // Alice's own cert is still technically VALIDE in its own AC, but its chain contains a revoked intermediate CA!
      resVal = avManager.handleRequest({
        method: 'POST',
        path: '/av/messagerie/validations',
        body: {
          numeroSerieCertificat: cert.numeroSerie,
          usageAttendu: 'SIGNATURE_ET_CHIFFREMENT',
          sujetAttendu: 'alice.martin@dsi.organisation.fr',
        },
      });
      expect(resVal.status).toBe(200);
      const valReponse = resVal.body as ValidationCertificatReponse;
      expect(valReponse.valide).toBe(false);
      expect(valReponse.detailsEtapes.etape3StatutAvOk).toBe(false);
      expect(valReponse.detailsEtapes.messageDiagnostic).toContain('AC');
    });
  });

  describe('Service de Publication : endpoints REST LCR (GET /annuaire/autorites/{acId}/lcr et GET /annuaire/lcr)', () => {
    it('should serve signed individual LCR and consolidated LCRs via REST', async () => {
      const aeMessagerie = aeManager.getAeParNature('messagerie');
      aeMessagerie.enregistrerEntite({
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE',
      });

      const resEnroll = await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-certification',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          genererBicle: true,
        },
      });
      const cert = (resEnroll.body as DemandeCertificationReponse).certificat!;

      // Revoke Alice's certificate
      await aeManager.handleRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          numeroSerieCertificat: cert.numeroSerie,
          action: 'REVOCATION',
          motif: 'COMPROMISSION_CLE_PRIVEE',
        },
      });

      // 1. GET /annuaire/autorites/{acId}/lcr
      const resLcrAc = annuaire.handleRequest({
        method: 'GET',
        path: '/annuaire/autorites/AC-N3-DSI-MESSAGERIE/lcr',
      });
      expect(resLcrAc.status).toBe(200);
      const lcrAc = resLcrAc.body as ListeCertificatsRevoques;
      expect(lcrAc.identifiantAc).toBe('AC-N3-DSI-MESSAGERIE');
      expect(lcrAc.numeroVersionLcr).toBeGreaterThanOrEqual(1);
      expect(lcrAc.entrees).toHaveLength(1);
      expect(lcrAc.entrees[0].numeroSerieCertificat).toBe(cert.numeroSerie);
      expect(lcrAc.entrees[0].statut).toBe('REVOQUE');
      expect(lcrAc.signatureAc).toBeDefined();

      // Cryptographically verify LCR signature against AC's public key
      const acN3 = hierarchie.acsNiveau3.find((ac) => ac.id === 'AC-N3-DSI-MESSAGERIE')!;
      expect(verifyLcrSignature(lcrAc, acN3.keyPair.publicKeyPem)).toBe(true);

      // 2. GET /annuaire/autorites/AC-INCONNUE/lcr -> 404
      const resLcrInconnue = annuaire.handleRequest({
        method: 'GET',
        path: '/annuaire/autorites/AC-INCONNUE/lcr',
      });
      expect(resLcrInconnue.status).toBe(404);
      expect((resLcrInconnue.body as ErreurApi).code).toBe('LCR_INTROUVABLE');

      // 3. GET /annuaire/lcr (Consolidated LCR)
      const resLcrConsolidee = annuaire.handleRequest({
        method: 'GET',
        path: '/annuaire/lcr',
      });
      expect(resLcrConsolidee.status).toBe(200);
      const lcrs = resLcrConsolidee.body as ListeCertificatsRevoques[];
      expect(Array.isArray(lcrs)).toBe(true);
      expect(lcrs.length).toBeGreaterThanOrEqual(1);
      const found = lcrs.find((l) => l.identifiantAc === 'AC-N3-DSI-MESSAGERIE');
      expect(found).toBeDefined();
      expect(found!.entrees).toHaveLength(1);
    });
  });
});
