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

export type NatureRessource =
  | 'messagerie'
  | 'routeurs'
  | 'services'
  | 'utilisateurs';

export interface DroitsEntiteAE {
  nomEntite: string;
  natureRessource: NatureRessource;
  droitSignature: boolean;
  droitChiffrement: boolean;
  droitDemandeRevocation: boolean;
  acRattachementId: string;
}

export interface EntiteAERegistre extends DroitsEntiteAE {
  motDePasseHash: string;
  salt: string;
}

export type StatutDemandeCertification =
  | 'EN_ATTENTE_AC'
  | 'EMISE'
  | 'REJETEE';

export interface DemandeCertificationRequete {
  nomEntite: string;
  motDePasse: string;
  acCibleId?: string;
  usage: UsageCle;
  clePublique?: string;
  genererBicle?: boolean;
}

export interface DemandeCertificationReponse {
  demandeId: string;
  statutDemande: StatutDemandeCertification;
  horodatage: string;
  certificat?: Certificat;
  clePriveeGeneree?: string | null;
}

export interface RestRequest {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  query?: Record<string, string | undefined>;
  headers?: Record<string, string | undefined>;
  body?: unknown;
}

export interface RestResponse<T = unknown> {
  status: number;
  headers?: Record<string, string>;
  body: T;
}

