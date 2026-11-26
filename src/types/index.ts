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
