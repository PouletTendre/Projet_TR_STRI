import { describe, it, expect, beforeEach } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import { bootstrapHierarchieAc } from '../src/ac/index.js';
import { ServicePublication } from '../src/annuaire/index.js';
import { verifyCertificatSignature } from '../src/crypto/index.js';
import type {
  AutoriteCertificationInfo,
  Certificat,
  CheminCertificationReponse,
  ErreurApi,
} from '../types/index.js';

describe('Service de Publication (Annuaire) & REST Seam', () => {
  let broker: InMemoryJmsBroker;
  let servicePub: ServicePublication;

  beforeEach(() => {
    broker = new InMemoryJmsBroker();
    servicePub = new ServicePublication(broker);
  });

  it('should automatically index certificates published on topic.pki.publications.certificats', () => {
    const hierarchie = bootstrapHierarchieAc(broker);
    servicePub.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    const resToutes = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/autorites',
    });
    expect(resToutes.status).toBe(200);
    const autorites = resToutes.body as AutoriteCertificationInfo[];
    expect(autorites).toHaveLength(6);

    // Filter by level
    const resNiveau1 = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/autorites',
      query: { niveau: '1' },
    });
    expect(resNiveau1.status).toBe(200);
    expect((resNiveau1.body as AutoriteCertificationInfo[])).toHaveLength(1);
    expect((resNiveau1.body as AutoriteCertificationInfo[])[0].acId).toBe('AC-N1-RACINE');

    const resNiveau2 = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/autorites',
      query: { niveau: '2' },
    });
    expect(resNiveau2.status).toBe(200);
    expect((resNiveau2.body as AutoriteCertificationInfo[])).toHaveLength(2);

    const resNiveau3 = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/autorites',
      query: { niveau: '3' },
    });
    expect(resNiveau3.status).toBe(200);
    expect((resNiveau3.body as AutoriteCertificationInfo[])).toHaveLength(3);
  });

  it('should retrieve a certificate by its unique serial number or return 404 ErreurApi', () => {
    const hierarchie = bootstrapHierarchieAc(broker);
    servicePub.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    const rootCert = hierarchie.acRacine.certificat;
    const res = servicePub.handleRequest({
      method: 'GET',
      path: `/annuaire/certificats/${rootCert.numeroSerie}`,
    });

    expect(res.status).toBe(200);
    const cert = res.body as Certificat;
    expect(cert.numeroSerie).toBe(rootCert.numeroSerie);
    expect(cert.sujet).toBe('AC-N1-RACINE');

    // Test 404
    const res404 = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats/SN-INCONNU-999',
    });
    expect(res404.status).toBe(404);
    const erreur = res404.body as ErreurApi;
    expect(erreur.code).toBe('CERTIFICAT_INTROUVABLE');
    expect(erreur.message).toContain('SN-INCONNU-999');
    expect(erreur.chemin).toBe('/annuaire/certificats/SN-INCONNU-999');
  });

  it('should resolve full certification path ordered from leaf to root (Level 3 -> Level 2 -> Level 1) and verify signatures', () => {
    const hierarchie = bootstrapHierarchieAc(broker);
    servicePub.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    // Target a Level 3 AC
    const acN3 = hierarchie.allAcs.find((ac) => ac.id === 'AC-N3-DSI-MESSAGERIE')!;
    const resCheminAc = servicePub.handleRequest({
      method: 'GET',
      path: `/annuaire/certificats/${acN3.certificat.numeroSerie}/chemin-certification`,
    });

    expect(resCheminAc.status).toBe(200);
    const cheminAc = resCheminAc.body as CheminCertificationReponse;
    expect(cheminAc.numeroSerieCible).toBe(acN3.certificat.numeroSerie);
    expect(cheminAc.profondeurHierarchie).toBe(3);
    expect(cheminAc.chaineCertificats).toHaveLength(3);

    // Verify ordering: Level 3 -> Level 2 -> Level 1
    expect(cheminAc.chaineCertificats[0].sujet).toBe('AC-N3-DSI-MESSAGERIE');
    expect(cheminAc.chaineCertificats[1].sujet).toBe('AC-N2-DSI');
    expect(cheminAc.chaineCertificats[2].sujet).toBe('AC-N1-RACINE');

    // Also issue an end-entity certificate signed by Level 3 AC
    const userCert = acN3.signerCertificat({
      numeroSerie: 'SN-2026-DSI-000142',
      sujet: 'alice.martin@dsi.organisation.fr',
      clePublique: 'dummyPublicKeyAlice',
      usage: 'SIGNATURE_ET_CHIFFREMENT',
      natureRessource: 'messagerie',
    });

    const resUserChemin = servicePub.handleRequest({
      method: 'GET',
      path: `/annuaire/certificats/${userCert.numeroSerie}/chemin-certification`,
    });

    expect(resUserChemin.status).toBe(200);
    const userChemin = resUserChemin.body as CheminCertificationReponse;
    expect(userChemin.numeroSerieCible).toBe('SN-2026-DSI-000142');
    expect(userChemin.profondeurHierarchie).toBe(3);
    expect(userChemin.chaineCertificats).toHaveLength(4);

    // Verify chain ordering: Leaf -> Level 3 -> Level 2 -> Level 1
    expect(userChemin.chaineCertificats[0].sujet).toBe('alice.martin@dsi.organisation.fr');
    expect(userChemin.chaineCertificats[1].sujet).toBe('AC-N3-DSI-MESSAGERIE');
    expect(userChemin.chaineCertificats[2].sujet).toBe('AC-N2-DSI');
    expect(userChemin.chaineCertificats[3].sujet).toBe('AC-N1-RACINE');

    // Cryptographic verification along the chain
    // Leaf signed by Level 3 AC
    expect(
      verifyCertificatSignature(
        userChemin.chaineCertificats[0],
        userChemin.chaineCertificats[1].clePublique
      )
    ).toBe(true);

    // Level 3 AC signed by Level 2 AC
    expect(
      verifyCertificatSignature(
        userChemin.chaineCertificats[1],
        userChemin.chaineCertificats[2].clePublique
      )
    ).toBe(true);

    // Level 2 AC signed by Level 1 AC Racine
    expect(
      verifyCertificatSignature(
        userChemin.chaineCertificats[2],
        userChemin.chaineCertificats[3].clePublique
      )
    ).toBe(true);

    // Level 1 AC Racine is self-signed
    expect(
      verifyCertificatSignature(
        userChemin.chaineCertificats[3],
        userChemin.chaineCertificats[3].clePublique
      )
    ).toBe(true);
  });

  it('should return 404 ErreurApi when querying chemin-certification for nonexistent certificate', () => {
    const res = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats/SN-NONEXISTENT/chemin-certification',
    });
    expect(res.status).toBe(404);
    const err = res.body as ErreurApi;
    expect(err.code).toBe('CERTIFICAT_INTROUVABLE');
  });

  it('should support searching certificates via GET /annuaire/certificats with filters', () => {
    const hierarchie = bootstrapHierarchieAc(broker);
    servicePub.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    const acN3 = hierarchie.allAcs.find((ac) => ac.id === 'AC-N3-DSI-MESSAGERIE')!;
    acN3.signerCertificat({
      numeroSerie: 'SN-2026-DSI-000142',
      sujet: 'alice.martin@dsi.organisation.fr',
      clePublique: 'dummyPublicKeyAlice',
      usage: 'SIGNATURE_ET_CHIFFREMENT',
      natureRessource: 'messagerie',
    });

    const resAll = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats',
    });
    expect(resAll.status).toBe(200);
    expect((resAll.body as Certificat[]).length).toBe(7); // 6 ACs + 1 user cert

    const resBySujet = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: 'alice.martin@dsi.organisation.fr' },
    });
    expect(resBySujet.status).toBe(200);
    expect((resBySujet.body as Certificat[])).toHaveLength(1);
    expect((resBySujet.body as Certificat[])[0].numeroSerie).toBe('SN-2026-DSI-000142');

    const resByUsage = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { usage: 'CERTIFICATION_AC' },
    });
    expect(resByUsage.status).toBe(200);
    expect((resByUsage.body as Certificat[])).toHaveLength(6);
  });

  it('should return 404 RESSOURCE_INTROUVABLE for unknown routes', () => {
    const res = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/unknown-route',
    });
    expect(res.status).toBe(404);
    const err = res.body as ErreurApi;
    expect(err.code).toBe('RESSOURCE_INTROUVABLE');
  });

  it('should support searching certificates by numeroSerie via rechercherCertificats and REST query', () => {
    const hierarchie = bootstrapHierarchieAc(broker);
    servicePub.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    const targetAc = hierarchie.allAcs[1];
    const targetSerial = targetAc.certificat.numeroSerie;

    // Search via direct method
    const directResults = servicePub.rechercherCertificats({ numeroSerie: targetSerial });
    expect(directResults).toHaveLength(1);
    expect(directResults[0].numeroSerie).toBe(targetSerial);

    // Search via REST endpoint query param
    const restResults = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { numeroSerie: targetSerial },
    });
    expect(restResults.status).toBe(200);
    const body = restResults.body as Certificat[];
    expect(body).toHaveLength(1);
    expect(body[0].numeroSerie).toBe(targetSerial);
  });

  it('should support filtering only valid certificates via uniquementValides query parameter', () => {
    const hierarchie = bootstrapHierarchieAc(broker);
    servicePub.enregistrerAutorites(hierarchie.allAcs.map((ac) => ac.getInfo()));

    const acN3 = hierarchie.allAcs.find((ac) => ac.id === 'AC-N3-DSI-MESSAGERIE')!;

    // 1. Valid certificate
    const validCert = acN3.signerCertificat({
      numeroSerie: 'SN-VALID-001',
      sujet: 'user.valid@dsi.organisation.fr',
      clePublique: 'dummyKeyValid',
      usage: 'SIGNATURE',
      natureRessource: 'messagerie',
    });

    // 2. Expired certificate
    const expiredCert = acN3.signerCertificat({
      numeroSerie: 'SN-EXPIRED-001',
      sujet: 'user.expired@dsi.organisation.fr',
      clePublique: 'dummyKeyExpired',
      usage: 'SIGNATURE',
      natureRessource: 'messagerie',
      dateDebutValidite: '2020-01-01T00:00:00Z',
      dateFinValidite: '2021-01-01T00:00:00Z',
    });

    // 3. Suspended certificate (registered in LCR)
    const suspendedCert = acN3.signerCertificat({
      numeroSerie: 'SN-SUSPENDED-001',
      sujet: 'user.suspended@dsi.organisation.fr',
      clePublique: 'dummyKeySuspended',
      usage: 'SIGNATURE',
      natureRessource: 'messagerie',
    });

    // 4. Revoked certificate (registered in LCR)
    const revokedCert = acN3.signerCertificat({
      numeroSerie: 'SN-REVOKED-001',
      sujet: 'user.revoked@dsi.organisation.fr',
      clePublique: 'dummyKeyRevoked',
      usage: 'SIGNATURE',
      natureRessource: 'messagerie',
    });

    // Publish LCR containing suspended and revoked certs
    broker.publish('topic.pki.publications.lcr', {
      headers: { identifiant_ac: acN3.id },
      payload: {
        identifiantAc: acN3.id,
        numeroVersionLcr: 1,
        entreesActives: [
          {
            numeroSerieCertificat: suspendedCert.numeroSerie,
            statut: 'SUSPENDU',
            dateInvalidation: new Date().toISOString(),
            motif: 'Suspension temporaire',
          },
          {
            numeroSerieCertificat: revokedCert.numeroSerie,
            statut: 'REVOQUE',
            dateInvalidation: new Date().toISOString(),
            motif: 'Clé compromise',
          },
        ],
      },
    });

    // When uniquementValides is false or absent: all 4 user certificates are returned
    const resAll = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { acEmettriceId: acN3.id },
    });
    expect((resAll.body as Certificat[])).toHaveLength(4);

    // When uniquementValides is true: only SN-VALID-001 should be returned!
    const resValides = servicePub.handleRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: {
        acEmettriceId: acN3.id,
        uniquementValides: 'true',
      },
    });
    expect(resValides.status).toBe(200);
    const valides = resValides.body as Certificat[];
    expect(valides).toHaveLength(1);
    expect(valides[0].numeroSerie).toBe('SN-VALID-001');

    // Also test direct method with boolean true
    const directValides = servicePub.rechercherCertificats({
      acEmettriceId: acN3.id,
      uniquementValides: true,
    });
    expect(directValides).toHaveLength(1);
    expect(directValides[0].numeroSerie).toBe('SN-VALID-001');
  });
});
