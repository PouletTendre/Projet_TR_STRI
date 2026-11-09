import crypto from 'node:crypto';
import type { Certificat, ListeCertificatsRevoques } from '../types/index.js';

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

export function serializeLcrDataToSign(
  lcrData: Omit<ListeCertificatsRevoques, 'signatureAc'>
): Buffer {
  const normalized = {
    dateEmission: lcrData.dateEmission,
    entrees: (lcrData.entrees ?? []).map((e) => ({
      dateInvalidation: e.dateInvalidation,
      motif: e.motif,
      numeroSerieCertificat: e.numeroSerieCertificat,
      statut: e.statut,
    })).sort((a, b) => a.numeroSerieCertificat.localeCompare(b.numeroSerieCertificat)),
    identifiantAc: lcrData.identifiantAc,
    numeroVersionLcr: lcrData.numeroVersionLcr,
    prochaineMiseAJour: lcrData.prochaineMiseAJour,
  };

  return Buffer.from(JSON.stringify(normalized), 'utf-8');
}

export function signLcr(
  lcrData: Omit<ListeCertificatsRevoques, 'signatureAc'>,
  signerPrivateKeyPem: string
): ListeCertificatsRevoques {
  const dataToSign = serializeLcrDataToSign(lcrData);
  const signer = crypto.createSign('SHA256');
  signer.update(dataToSign);
  signer.end();
  const signatureBase64 = signer.sign(signerPrivateKeyPem, 'base64');

  return {
    ...lcrData,
    signatureAc: signatureBase64,
  };
}

export function verifyLcrSignature(
  lcr: ListeCertificatsRevoques,
  signerPublicKeyPemOrBase64: string
): boolean {
  try {
    const publicKeyPem = base64ToPublicKeyPem(signerPublicKeyPemOrBase64);
    const dataToVerify = serializeLcrDataToSign(lcr);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(dataToVerify);
    verifier.end();
    return verifier.verify(publicKeyPem, lcr.signatureAc, 'base64');
  } catch {
    return false;
  }
}

export function base64ToPrivateKeyPem(b64OrPem: string): string {
  if (
    b64OrPem.includes('BEGIN PRIVATE KEY') ||
    b64OrPem.includes('BEGIN RSA PRIVATE KEY')
  ) {
    return b64OrPem;
  }
  const cleanB64 = b64OrPem.replace(/\s+/g, '');
  const lines = cleanB64.match(/.{1,64}/g) || [];
  return `-----BEGIN PRIVATE KEY-----\n${lines.join('\n')}\n-----END PRIVATE KEY-----\n`;
}

export interface ChatMessageDataToSign {
  echangeId: string;
  numeroSequence: number;
  horodatage: string;
  texte: string;
}

export function serializeChatMessageData(data: ChatMessageDataToSign): Buffer {
  return Buffer.from(
    `${data.echangeId}|${data.numeroSequence}|${data.horodatage}|${data.texte}`,
    'utf-8'
  );
}

export function signChatMessage(
  data: ChatMessageDataToSign,
  privateKeyPemOrBase64: string
): string {
  const privateKeyPem = base64ToPrivateKeyPem(privateKeyPemOrBase64);
  const dataToSign = serializeChatMessageData(data);
  const signer = crypto.createSign('SHA256');
  signer.update(dataToSign);
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

export function verifyChatMessageSignature(
  data: ChatMessageDataToSign,
  signatureBase64: string,
  publicKeyPemOrBase64: string
): boolean {
  try {
    const pem = base64ToPublicKeyPem(publicKeyPemOrBase64);
    const dataToVerify = serializeChatMessageData(data);
    const verifier = crypto.createVerify('SHA256');
    verifier.update(dataToVerify);
    verifier.end();
    return verifier.verify(pem, signatureBase64, 'base64');
  } catch {
    return false;
  }
}

export interface EncryptedPayload {
  contenuTexte: string;
  cleSessionChiffreeCpDestinataire: string;
  iv: string;
  tag: string;
  algorithmeChiffrement: string;
}

export function encryptChatMessage(
  texte: string,
  recipientPublicKeyPemOrBase64: string
): EncryptedPayload {
  const recipientPem = base64ToPublicKeyPem(recipientPublicKeyPemOrBase64);
  const aesKey = crypto.randomBytes(32); // AES-256
  const iv = crypto.randomBytes(12); // GCM 96-bit IV

  const cipher = crypto.createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertextBuffer = Buffer.concat([
    cipher.update(texte, 'utf-8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  const encryptedSessionKey = crypto.publicEncrypt(
    {
      key: recipientPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    aesKey
  );

  return {
    contenuTexte: ciphertextBuffer.toString('base64'),
    cleSessionChiffreeCpDestinataire: encryptedSessionKey.toString('base64'),
    iv: iv.toString('base64'),
    tag: authTag.toString('base64'),
    algorithmeChiffrement: 'RSA-OAEP-256+AES-256-GCM',
  };
}

export function decryptChatMessage(
  payload: {
    contenuTexte: string;
    cleSessionChiffreeCpDestinataire?: string | null;
    iv?: string | null;
    tag?: string | null;
  },
  recipientPrivateKeyPemOrBase64: string
): string {
  const privateKeyPem = base64ToPrivateKeyPem(recipientPrivateKeyPemOrBase64);

  // Hybrid AES-256-GCM + RSA-OAEP
  if (payload.cleSessionChiffreeCpDestinataire && payload.iv) {
    const aesKey = crypto.privateDecrypt(
      {
        key: privateKeyPem,
        padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
        oaepHash: 'sha256',
      },
      Buffer.from(payload.cleSessionChiffreeCpDestinataire, 'base64')
    );

    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      aesKey,
      Buffer.from(payload.iv, 'base64')
    );
    if (payload.tag) {
      decipher.setAuthTag(Buffer.from(payload.tag, 'base64'));
    }

    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(payload.contenuTexte, 'base64')),
      decipher.final(),
    ]);

    return decrypted.toString('utf-8');
  }

  // Pure RSA-OAEP fallback
  const decrypted = crypto.privateDecrypt(
    {
      key: privateKeyPem,
      padding: crypto.constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256',
    },
    Buffer.from(payload.contenuTexte, 'base64')
  );
  return decrypted.toString('utf-8');
}
