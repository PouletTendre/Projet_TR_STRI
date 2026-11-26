import {
  constants,
  createCipheriv,
  createDecipheriv,
  createSign,
  createVerify,
  generateKeyPairSync,
  privateDecrypt,
  publicEncrypt,
  randomBytes,
  scryptSync,
  timingSafeEqual
} from 'node:crypto';
import type { Certificat, ListeCertificatsRevoques } from '../types/index.js';

export interface RsaKeyPair {
  publicKeyPem: string;
  privateKeyPem: string;
  publicKeyBase64: string;
}

interface HybridEncryptedEnvelope {
  alg: 'RSA-OAEP-256+AES-256-GCM';
  encryptedKey: string;
  iv: string;
  authTag: string;
  ciphertext: string;
}

const PEM_PUBLIC_HEADER = '-----BEGIN PUBLIC KEY-----';
const PEM_PUBLIC_FOOTER = '-----END PUBLIC KEY-----';

/**
 * Génère une Biclé RSA-2048 au format PEM (SPKI / PKCS8) et sa représentation Base64.
 */
export function generateRsaKeyPair(): RsaKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    publicKeyEncoding: {
      type: 'spki',
      format: 'pem'
    },
    privateKeyEncoding: {
      type: 'pkcs8',
      format: 'pem'
    }
  });

  return {
    publicKeyPem: publicKey,
    privateKeyPem: privateKey,
    publicKeyBase64: publicKeyPemToBase64(publicKey)
  };
}

/**
 * Convertit une clé publique PEM SPKI en chaîne Base64 sans en-têtes ni retours à la ligne.
 */
export function publicKeyPemToBase64(pem: string): string {
  return pem
    .replace(/-----BEGIN [^-]+-----/g, '')
    .replace(/-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
}

/**
 * Convertit une clé publique encodée en Base64 SPKI vers le format PEM standard.
 */
export function publicKeyBase64ToPem(base64: string): string {
  const clean = publicKeyPemToBase64(base64);
  const lines = clean.match(/.{1,64}/g) ?? [];
  return `${PEM_PUBLIC_HEADER}\n${lines.join('\n')}\n${PEM_PUBLIC_FOOTER}\n`;
}

function normalizePublicKeyToPem(publicKeyPemOrBase64: string): string {
  if (publicKeyPemOrBase64.includes('-----BEGIN')) {
    return publicKeyPemOrBase64;
  }
  return publicKeyBase64ToPem(publicKeyPemOrBase64);
}

/**
 * Sérialise une valeur JSON de manière canonique (clés triées récursivement).
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((k) => record[k] !== undefined)
    .sort();
  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`
  );
  return `{${entries.join(',')}}`;
}

function signCanonicalPayload(payload: unknown, privateKeyPem: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(canonicalJson(payload), 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

function verifyCanonicalPayload(
  payload: unknown,
  signatureBase64: string,
  publicKeyPemOrBase64: string
): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(canonicalJson(payload), 'utf8');
    verifier.end();
    return verifier.verify(
      normalizePublicKeyToPem(publicKeyPemOrBase64),
      signatureBase64,
      'base64'
    );
  } catch {
    return false;
  }
}

/**
 * Signe un Certificat en SHA256withRSA sur sa représentation JSON canonique.
 */
export function signCertificat(
  certSansSignature: Omit<Certificat, 'signatureAc'>,
  privateKeyPem: string
): Certificat {
  const signatureAc = signCanonicalPayload(certSansSignature, privateKeyPem);
  return {
    ...certSansSignature,
    signatureAc
  };
}

/**
 * Vérifie la signature SHA256withRSA d'un Certificat à l'aide de la clé publique de l'AC émettrice.
 */
export function verifyCertificatSignature(
  certificat: Certificat,
  acPublicKeyPemOrBase64: string
): boolean {
  const { signatureAc, ...payloadSansSignature } = certificat;
  if (!signatureAc) {
    return false;
  }
  return verifyCanonicalPayload(
    payloadSansSignature,
    signatureAc,
    acPublicKeyPemOrBase64
  );
}

/**
 * Signe une Liste des Certificats Révoqués (LCR) en SHA256withRSA.
 */
export function signLcr(
  lcrSansSignature: Omit<ListeCertificatsRevoques, 'signatureAc'>,
  privateKeyPem: string
): ListeCertificatsRevoques {
  const signatureAc = signCanonicalPayload(lcrSansSignature, privateKeyPem);
  return {
    ...lcrSansSignature,
    signatureAc
  };
}

/**
 * Vérifie la signature SHA256withRSA d'une LCR à l'aide de la clé publique de l'AC émettrice.
 */
export function verifyLcrSignature(
  lcr: ListeCertificatsRevoques,
  acPublicKeyPemOrBase64: string
): boolean {
  const { signatureAc, ...payloadSansSignature } = lcr;
  if (!signatureAc) {
    return false;
  }
  return verifyCanonicalPayload(
    payloadSansSignature,
    signatureAc,
    acPublicKeyPemOrBase64
  );
}

/**
 * Hache un mot de passe avec un sel aléatoire (16 octets) et scrypt.
 */
export function hashPassword(password: string): string {
  const salt = randomBytes(16).toString('hex');
  const derived = scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

/**
 * Vérifie un mot de passe face à un condensat scrypt en temps constant (timingSafeEqual).
 */
export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = storedHash.split(':');
  if (parts.length !== 2) {
    return false;
  }
  const [salt, expectedHex] = parts;
  if (!salt || !expectedHex) {
    return false;
  }
  const expectedBuf = Buffer.from(expectedHex, 'hex');
  const actualBuf = scryptSync(password, salt, 64);
  if (expectedBuf.length !== actualBuf.length) {
    return false;
  }
  return timingSafeEqual(expectedBuf, actualBuf);
}

/**
 * Signe un message texte de messagerie sécurisée avec RSA-SHA256.
 */
export function signMessageText(plaintext: string, privateKeyPem: string): string {
  const signer = createSign('RSA-SHA256');
  signer.update(plaintext, 'utf8');
  signer.end();
  return signer.sign(privateKeyPem, 'base64');
}

/**
 * Vérifie la signature RSA-SHA256 d'un message texte de messagerie sécurisée.
 */
export function verifyMessageSignature(
  plaintext: string,
  signatureBase64: string,
  publicKeyPemOrBase64: string
): boolean {
  try {
    const verifier = createVerify('RSA-SHA256');
    verifier.update(plaintext, 'utf8');
    verifier.end();
    return verifier.verify(
      normalizePublicKeyToPem(publicKeyPemOrBase64),
      signatureBase64,
      'base64'
    );
  } catch {
    return false;
  }
}

/**
 * Chiffre un message texte par chiffrement hybride RSA-OAEP-256 + AES-256-GCM.
 */
export function encryptHybridMessage(
  plaintext: string,
  recipientPublicKeyPemOrBase64: string
): string {
  const aesKey = randomBytes(32);
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', aesKey, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final()
  ]);
  const authTag = cipher.getAuthTag();

  const encryptedKey = publicEncrypt(
    {
      key: normalizePublicKeyToPem(recipientPublicKeyPemOrBase64),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    aesKey
  );

  const envelope: HybridEncryptedEnvelope = {
    alg: 'RSA-OAEP-256+AES-256-GCM',
    encryptedKey: encryptedKey.toString('base64'),
    iv: iv.toString('base64'),
    authTag: authTag.toString('base64'),
    ciphertext: ciphertext.toString('base64')
  };

  return JSON.stringify(envelope);
}

/**
 * Déchiffre une enveloppe hybride RSA-OAEP-256 + AES-256-GCM avec la clé privée du Correspondant récepteur.
 */
export function decryptHybridMessage(
  encryptedJson: string,
  recipientPrivateKeyPem: string
): string {
  const envelope = JSON.parse(encryptedJson) as HybridEncryptedEnvelope;
  if (envelope.alg !== 'RSA-OAEP-256+AES-256-GCM') {
    throw new Error(`Algorithme de chiffrement hybride non supporté: ${String(envelope.alg)}`);
  }

  const aesKey = privateDecrypt(
    {
      key: recipientPrivateKeyPem,
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: 'sha256'
    },
    Buffer.from(envelope.encryptedKey, 'base64')
  );

  const decipher = createDecipheriv(
    'aes-256-gcm',
    aesKey,
    Buffer.from(envelope.iv, 'base64')
  );
  decipher.setAuthTag(Buffer.from(envelope.authTag, 'base64'));

  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final()
  ]);

  return plaintext.toString('utf8');
}
