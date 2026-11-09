import crypto from 'node:crypto';
import type { Certificat } from '../types/index.js';

export interface RsaKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyBase64: string;
}

export function pemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [A-Z\s]+-----/g, '')
    .replace(/-----END [A-Z\s]+-----/g, '')
    .replace(/\s+/g, '');
}

export function base64ToPublicKeyPem(b64OrPem: string): string {
  if (b64OrPem.includes('BEGIN PUBLIC KEY')) {
    return b64OrPem;
  }
  const cleanB64 = b64OrPem.replace(/\s+/g, '');
  const lines = cleanB64.match(/.{1,64}/g) || [];
  return `-----BEGIN PUBLIC KEY-----\n${lines.join('\n')}\n-----END PUBLIC KEY-----\n`;
}

export function generateRsaKeyPair(modulusLength = 2048): RsaKeyPair {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
    modulusLength,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem',
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem',
    },
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    publicKeyBase64: pemToBase64(publicKey),
  };
}

export function serializeCertificatDataToSign(
  certData: Omit<Certificat, 'signatureAc'>
): Buffer {
  const normalized = {
    algorithmeSignature: certData.algorithmeSignature ?? 'SHA256withRSA',
    clePublique: pemToBase64(certData.clePublique),
    dateDebutValidite: certData.dateDebutValidite,
    dateFinValidite: certData.dateFinValidite,
    identifiantAcEmettrice: certData.identifiantAcEmettrice,
    natureRessource: certData.natureRessource ?? null,
    niveauAcEmettrice: certData.niveauAcEmettrice ?? null,
    numeroSerie: certData.numeroSerie,
    sujet: certData.sujet,
    usage: certData.usage,
  };

  const keys = Object.keys(normalized).sort() as (keyof typeof normalized)[];
  const sortedObj: Record<string, unknown> = {};
  for (const k of keys) {
    sortedObj[k] = normalized[k];
  }

  return Buffer.from(JSON.stringify(sortedObj), 'utf-8');
}

export function signCertificat(
  certData: Omit<Certificat, 'signatureAc'>,
  signerPrivateKeyPem: string
): Certificat {
  const dataToSign = serializeCertificatDataToSign(certData);
  const signer = crypto.createSign('SHA256');
  signer.update(dataToSign);
  signer.end();
  const signatureBase64 = signer.sign(signerPrivateKeyPem, 'base64');

  return {
    ...certData,
    clePublique: pemToBase64(certData.clePublique),
    algorithmeSignature: certData.algorithmeSignature ?? 'SHA256withRSA',
    signatureAc: signatureBase64,
  };
}

export function verifyCertificatSignature(
  cert: Certificat,
  signerPublicKeyPemOrBase64: string
): boolean {
  try {
    const publicKeyPem = base64ToPublicKeyPem(signerPublicKeyPemOrBase64);
    const dataToVerify = serializeCertificatDataToSign(cert);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(dataToVerify);
    verifier.end();
    return verifier.verify(publicKeyPem, cert.signatureAc, 'base64');
  } catch {
    return false;
  }
}
