export type UsageCle =
  | 'SIGNATURE'
  | 'CHIFFREMENT'
  | 'SIGNATURE_ET_CHIFFREMENT'
  | 'CERTIFICATION_AC';

export type StatutCertificat = 'VALIDE' | 'SUSPENDU' | 'REVOQUE' | 'INCONNU';

export type ActionRevocation = 'REVOCATION' | 'SUSPENSION' | 'REACTIVATION';

export type MotifRevocation =
  | 'COMPROMISSION_CLE_PRIVEE'
  | 'CESSATION_ACTIVITE'
  | 'CHANGEMENT_AFFILIATION'
  | 'SUSPENSION_TEMPORAIRE'
  | 'FIN_SUSPENSION'
  | 'AUTRE'
  | (string & {});

export type NatureRessource =
  | 'messagerie'
  | 'routeurs'
  | 'services'
  | 'utilisateurs'
  | (string & {});

export type TypeMessageAmqp =
  | 'DEMANDE_CERTIFICATION'
  | 'REPONSE_CERTIFICATION'
  | 'DEMANDE_REVOCATION'
  | 'REPONSE_REVOCATION'
  | 'PUBLICATION_CERTIFICAT'
  | 'PUBLICATION_LCR'
  | 'INIT_ECHANGE'
  | 'MSG_TEXTE'
  | 'FIN_MSG';

export type NiveauSecurite =
  | 'NON_SECURISE'
  | 'SIGNE'
  | 'CHIFFRE'
  | 'SIGNE_ET_CHIFFRE';

export interface Certificat {
  numeroSerie: string;
  identifiantAcEmettrice: string;
  dateDebutValidite: string;
  dateFinValidite: string;
  usage: UsageCle;
  sujet: string;
  clePublique: string;
  signatureAc: string;
  niveauAcEmettrice?: number;
  natureRessource?: string;
  algorithmeSignature?: string;
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

export interface EntreeLcr {
  numeroSerieCertificat: string;
  statut: 'REVOQUE' | 'SUSPENDU';
  dateInvalidation: string;
  motif: MotifRevocation;
}

export interface ListeCertificatsRevoques {
  identifiantAc: string;
  numeroVersionLcr: number;
  dateEmission: string;
  prochaineMiseAJour: string;
  entrees: EntreeLcr[];
  signatureAc: string;
}

export interface PublicationCertificatPayload {
  certificat: Certificat;
  autoriteInfo?: AutoriteCertificationInfo;
}

export interface PublicationLcrPayload {
  lcr: ListeCertificatsRevoques;
}

export interface ErreurApi {
  code: string;
  message: string;
  horodatage: string;
  chemin?: string;
}

export interface RestRequest<TBody = unknown> {
  method: string;
  path: string;
  query?: Record<string, string | number | boolean | undefined>;
  headers?: Record<string, string | undefined>;
  body?: TBody;
}

export interface RestResponse<TBody = unknown> {
  status: number;
  body: TBody;
  headers?: Record<string, string>;
}

export type RestTransport = (req: RestRequest) => Promise<RestResponse>;

export interface StatutCertificatReponse {
  numeroSerie: string;
  statut: StatutCertificat;
  identifiantAcEmettrice: string | null;
  motifInvalidation: string | null;
  dateInvalidation: string | null;
  horodatageVerification: string;
  identifiantAv: string;
}

export interface ValidationCertificatRequete {
  numeroSerieCertificat: string;
  natureRessource: NatureRessource;
  usageAttendu: UsageCle;
  sujetAttendu?: string;
}

export interface DetailsEtapesValidation {
  etape1ValiditeTemporelle: boolean;
  etape2ChaineEtSignatures: boolean;
  etape3StatutAv: boolean;
  etape4PolitiqueUsageEtSujet: boolean;
  messageDiagnostic: string;
}

export interface ValidationCertificatReponse {
  valide: boolean;
  numeroSerieCertificat: string;
  statutCourant: StatutCertificat;
  detailsEtapes: DetailsEtapesValidation;
  cheminCertification: Certificat[];
  horodatageValidation: string;
}

export type AmqpExchangeType = 'direct' | 'topic';

export interface AmqpProperties {
  content_type: string;
  delivery_mode: 1 | 2;
  message_id: string;
  timestamp: string;
  type?: TypeMessageAmqp | string;
  correlation_id?: string;
  reply_to?: string;
  headers?: Record<string, unknown>;
}

export type AmqpPublishProperties = Partial<AmqpProperties>;

export interface AmqpMessage<TPayload = unknown> {
  exchange: string;
  routingKey: string;
  payload: TPayload;
  rawBody: string;
  properties: AmqpProperties;
}

export type AmqpConsumerHandler<TPayload = unknown> = (
  message: AmqpMessage<TPayload>
) => void | Promise<void>;

export interface DroitsEntiteAE {
  nomEntite: string;
  natureRessource?: string;
  droitSignature: boolean;
  droitChiffrement: boolean;
  droitDemandeRevocation: boolean;
  acRattachementId: string;
}

export interface EntiteAEInscription {
  nomEntite: string;
  motDePasse: string;
  droitSignature: boolean;
  droitChiffrement: boolean;
  droitDemandeRevocation: boolean;
  acRattachementId: string;
}

export interface EntiteAERegistre {
  nomEntite: string;
  natureRessource: NatureRessource;
  motDePasseHash: string;
  droitSignature: boolean;
  droitChiffrement: boolean;
  droitDemandeRevocation: boolean;
  acRattachementId: string;
}

export type StatutDemandeCertification = 'EN_ATTENTE_AC' | 'EMISE' | 'REJETEE';

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

export interface CommandeDemandeCertificationPayload {
  demandeId: string;
  sujet: string;
  natureRessource: NatureRessource;
  acCibleId: string;
  usage: UsageCle;
  clePublique?: string;
  genererBicle: boolean;
  dureeValiditeJours?: number;
}

export interface ReponseDemandeCertificationPayload {
  demandeId: string;
  statut: 'EMISE' | 'REJETEE';
  certificat?: Certificat;
  clePriveeGeneree?: string | null;
  erreur?: {
    code: string;
    message: string;
  };
}

export interface DemandeRevocationRequete {
  nomEntite: string;
  motDePasse: string;
  numeroSerieCertificat: string;
  action: ActionRevocation;
  motif?: MotifRevocation;
}

export interface DemandeRevocationReponse {
  demandeId: string;
  numeroSerieCertificat: string;
  identifiantAc?: string;
  actionAppliquee: ActionRevocation;
  nouvelEtatCertificat: StatutCertificat;
  horodatagePublicationLcr: string;
}

export interface CommandeDemandeRevocationPayload {
  demandeId: string;
  sujet: string;
  numeroSerieCertificat: string;
  acCibleId: string;
  action: ActionRevocation;
  motif?: MotifRevocation;
}

export interface ReponseDemandeRevocationPayload {
  demandeId: string;
  numeroSerieCertificat: string;
  identifiantAc: string;
  statut: 'APPLIQUEE' | 'REJETEE';
  actionAppliquee?: ActionRevocation;
  nouvelEtatCertificat?: StatutCertificat;
  horodatagePublicationLcr?: string;
  erreur?: {
    httpStatus?: number;
    code: string;
    message: string;
  };
}
