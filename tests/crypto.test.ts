import { describe, it, expect } from 'vitest';
import {
  generateRsaKeyPair,
  signCertificat,
  verifyCertificatSignature,
  base64ToPublicKeyPem,
  pemToBase64,
} from '../src/crypto/index.js';
import type { Certificat } from '../src/types/index.js';

describe('Crypto Module', () => {
  it('should generate valid RSA 2048 keypair in PEM and base64 formats', () => {
    const keyPair = generateRsaKeyPair();
    expect(keyPair.privateKeyPem).toContain('BEGIN PRIVATE KEY');
    expect(keyPair.publicKeyPem).toContain('BEGIN PUBLIC KEY');
    expect(keyPair.publicKeyBase64).toBeDefined();
    expect(keyPair.publicKeyBase64).not.toContain('BEGIN PUBLIC KEY');

    const reconstructedPem = base64ToPublicKeyPem(keyPair.publicKeyBase64);
    expect(pemToBase64(reconstructedPem)).toBe(keyPair.publicKeyBase64);
  });

  it('should sign and verify a certificate using SHA256withRSA', () => {
    const acKeyPair = generateRsaKeyPair();
    const subjectKeyPair = generateRsaKeyPair();

    const certData: Omit<Certificat, 'signatureAc'> = {
      numeroSerie: 'SN-TEST-001',
      identifiantAcEmettrice: 'AC-N1-RACINE',
      niveauAcEmettrice: 1,
      dateDebutValidite: '2026-01-01T00:00:00.000Z',
      dateFinValidite: '2036-01-01T00:00:00.000Z',
      usage: 'CERTIFICATION_AC',
      sujet: 'AC-N1-RACINE',
      natureRessource: 'autorite_certification',
      clePublique: subjectKeyPair.publicKeyBase64,
      algorithmeSignature: 'SHA256withRSA',
    };

    const signedCert = signCertificat(certData, acKeyPair.privateKeyPem);

    expect(signedCert.signatureAc).toBeDefined();
    expect(typeof signedCert.signatureAc).toBe('string');
    expect(signedCert.signatureAc.length).toBeGreaterThan(50);

    const isValid = verifyCertificatSignature(signedCert, acKeyPair.publicKeyPem);
    expect(isValid).toBe(true);

    const isValidWithBase64Key = verifyCertificatSignature(signedCert, acKeyPair.publicKeyBase64);
    expect(isValidWithBase64Key).toBe(true);

    // Tampering test
    const tamperedCert = { ...signedCert, sujet: 'impostor' };
    expect(verifyCertificatSignature(tamperedCert, acKeyPair.publicKeyPem)).toBe(false);

    // Wrong public key test
    const wrongKeyPair = generateRsaKeyPair();
    expect(verifyCertificatSignature(signedCert, wrongKeyPair.publicKeyPem)).toBe(false);
  });
});
