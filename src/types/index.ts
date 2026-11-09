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
  | 'utilisateurs'
  | (string & {});

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

export interface StatutCertificatReponse {
  numeroSerie: string;
  statut: StatutCertificat;
  identifiantAcEmettrice?: string;
  motifInvalidation?: string | null;
  dateInvalidation?: string | null;
  horodatageVerification: string;
  identifiantAv: string;
}

export interface ValidationCertificatRequete {
  numeroSerieCertificat: string;
  usageAttendu: UsageCle;
  sujetAttendu?: string;
}

export interface DetailsEtapesValidation {
  etape1PeriodeValiditeOk: boolean;
  etape2SignatureEtCheminOk: boolean;
  etape3StatutAvOk: boolean;
  etape4PolitiqueUsageOk: boolean;
  messageDiagnostic?: string;
}

export interface ValidationCertificatReponse {
  valide: boolean;
  numeroSerieCertificat: string;
  statutCourant?: StatutCertificat;
  detailsEtapes: DetailsEtapesValidation;
  cheminCertification: string[];
  horodatageValidation: string;
}

export type ActionRevocation = 'REVOCATION' | 'SUSPENSION' | 'REACTIVATION';

export interface DemandeRevocationRequete {
  nomEntite: string;
  motDePasse: string;
  numeroSerieCertificat: string;
  action: ActionRevocation;
  motif?: string;
}

export interface DemandeRevocationReponse {
  demandeId: string;
  numeroSerieCertificat: string;
  identifiantAc?: string;
  actionAppliquee: ActionRevocation;
  nouvelEtatCertificat: StatutCertificat;
  horodatagePublicationLcr: string;
}

export interface EntreeLcr {
  numeroSerieCertificat: string;
  statut: 'REVOQUE' | 'SUSPENDU';
  dateInvalidation: string;
  motif: string;
}

export interface ListeCertificatsRevoques {
  identifiantAc: string;
  numeroVersionLcr: number;
  dateEmission: string;
  prochaineMiseAJour: string;
  entrees: EntreeLcr[];
  signatureAc: string;
}

export interface LcrEvenementDeclencheur {
  numeroSerieCertificat: string;
  action: ActionRevocation;
  nouveauStatut: StatutCertificat;
  motif?: string;
  dateEffet: string;
}

export interface LcrEntreeActive {
  numeroSerieCertificat: string;
  statut: StatutCertificat;
  dateInvalidation: string;
  motif?: string;
}

export interface PublicationLcrPayload {
  identifiantAc: string;
  numeroVersionLcr?: number;
  dateEmission?: string;
  prochaineMiseAJour?: string;
  evenementDeclencheur?: LcrEvenementDeclencheur;
  entreesActives?: LcrEntreeActive[];
  lcr?: ListeCertificatsRevoques;
  signatureAc?: string;
}

export * from '../chat/types.js';

