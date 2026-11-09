import { describe, it, expect } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import {
  AutoriteCertification,
  bootstrapHierarchieAc,
} from '../src/ac/index.js';
import { verifyCertificatSignature } from '../src/crypto/index.js';
import type { Certificat } from '../src/types/index.js';

describe('AutoriteCertification & 3-level Hierarchy', () => {
  it('should initialize AC Racine with self-signed certificate and publish it on broker', () => {
    const broker = new InMemoryJmsBroker();
    const publishedCerts: Certificat[] = [];

    broker.subscribe('topic.pki.publications.certificats', (msg) => {
      publishedCerts.push(msg.payload as Certificat);
    });

    const acRacine = AutoriteCertification.createRoot({
      id: 'AC-N1-RACINE',
      nomOrganisationnel: 'Direction Générale — Autorité Racine',
      broker,
    });

    expect(acRacine.niveau).toBe(1);
    expect(acRacine.acParenteId).toBeNull();
    expect(acRacine.certificat.identifiantAcEmettrice).toBe('AC-N1-RACINE');
    expect(acRacine.certificat.sujet).toBe('AC-N1-RACINE');
    expect(acRacine.certificat.usage).toBe('CERTIFICATION_AC');

    // Self-signature check
    const isSelfSignedValid = verifyCertificatSignature(
      acRacine.certificat,
      acRacine.certificat.clePublique
    );
    expect(isSelfSignedValid).toBe(true);

    // Published on broker
    expect(publishedCerts).toHaveLength(1);
    expect(publishedCerts[0].numeroSerie).toBe(acRacine.certificat.numeroSerie);
  });

  it('should create Level 2 and Level 3 ACs signed by their parents', () => {
    const broker = new InMemoryJmsBroker();
    const publishedCerts: Certificat[] = [];

    broker.subscribe('topic.pki.publications.certificats', (msg) => {
      publishedCerts.push(msg.payload as Certificat);
    });

    const acRacine = AutoriteCertification.createRoot({
      id: 'AC-N1-RACINE',
      nomOrganisationnel: 'Direction Générale — Autorité Racine',
      broker,
    });

    const acN2 = acRacine.creerAcFille({
      id: 'AC-N2-DSI',
      nomOrganisationnel: 'Direction des Systèmes d’Information',
    });

    expect(acN2.niveau).toBe(2);
    expect(acN2.acParenteId).toBe('AC-N1-RACINE');
    expect(acN2.certificat.identifiantAcEmettrice).toBe('AC-N1-RACINE');
    expect(acN2.certificat.usage).toBe('CERTIFICATION_AC');

    // Signature verified using AC Racine's public key
    expect(
      verifyCertificatSignature(acN2.certificat, acRacine.certificat.clePublique)
    ).toBe(true);

    const acN3 = acN2.creerAcFille({
      id: 'AC-N3-DSI-MESSAGERIE',
      nomOrganisationnel: 'DSI — Service Messagerie',
    });

    expect(acN3.niveau).toBe(3);
    expect(acN3.acParenteId).toBe('AC-N2-DSI');
    expect(acN3.certificat.identifiantAcEmettrice).toBe('AC-N2-DSI');
    expect(acN3.certificat.usage).toBe('CERTIFICATION_AC');

    // Signature verified using AC N2's public key
    expect(
      verifyCertificatSignature(acN3.certificat, acN2.certificat.clePublique)
    ).toBe(true);

    // All 3 certificates published
    expect(publishedCerts).toHaveLength(3);
  });

  it('should bootstrap full 3-level hierarchy with 6 ACs correctly linked', () => {
    const broker = new InMemoryJmsBroker();
    const publishedCerts: Certificat[] = [];

    broker.subscribe('topic.pki.publications.certificats', (msg) => {
      publishedCerts.push(msg.payload as Certificat);
    });

    const hierarchie = bootstrapHierarchieAc(broker);

    expect(hierarchie.acRacine.id).toBe('AC-N1-RACINE');
    expect(hierarchie.acsNiveau2).toHaveLength(2);
    expect(hierarchie.acsNiveau3).toHaveLength(3);
    expect(hierarchie.allAcs).toHaveLength(6);

    // Verify all 6 published
    expect(publishedCerts).toHaveLength(6);

    // Verify cryptographic chain for AC-N3-DSI-MESSAGERIE
    const acN3Msg = hierarchie.allAcs.find((ac) => ac.id === 'AC-N3-DSI-MESSAGERIE')!;
    const acN2Dsi = hierarchie.allAcs.find((ac) => ac.id === acN3Msg.acParenteId)!;
    const acRoot = hierarchie.allAcs.find((ac) => ac.id === acN2Dsi.acParenteId)!;

    expect(verifyCertificatSignature(acN3Msg.certificat, acN2Dsi.certificat.clePublique)).toBe(true);
    expect(verifyCertificatSignature(acN2Dsi.certificat, acRoot.certificat.clePublique)).toBe(true);
    expect(verifyCertificatSignature(acRoot.certificat, acRoot.certificat.clePublique)).toBe(true);
  });
});
