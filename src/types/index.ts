export type UsageCle =
  | 'SIGNATURE'
  | 'CHIFFREMENT'
  | 'SIGNATURE_ET_CHIFFREMENT'
  | 'CERTIFICATION_AC';

export type StatutCertificat = 'VALIDE' | 'SUSPENDU' | 'REVOQUE' | 'INCONNU';

export interface Certificat {
  numeroSerie: string;
  identifiantAcEmettrice: string;
  niveauAcEmettrice?: number;
  dateDebutValidite: string;
  dateFinValidite: string;
  usage: UsageCle;
  sujet: string;
  natureRessource?: string;
  clePublique: string;
  algorithmeSignature?: string;
  signatureAc: string;
}

export interface AutoriteCertificationInfo {
  acId: string;
  nomOrganisationnel: string;
  niveau: number;
  acParenteId: string | null;
  certificatAc: Certificat;
}

export interface CheminCertificationReponse {
  numeroSerieCible: string;
  profondeurHierarchie: number;
  chaineCertificats: Certificat[];
}

export interface ErreurApi {
  code: string;
  message: string;
  horodatage: string;
  chemin: string;
}

export * from '../chat/types.js';
