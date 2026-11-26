import type {
  Certificat,
  NatureRessource,
  NiveauSecurite
} from '../types/index.js';
import type { UtilisateurIcpClient } from '../client/utilisateur-icp.js';

export type { NiveauSecurite };

export type TypeMessageChat = 'INIT_ECHANGE' | 'MSG_TEXTE' | 'FIN_MSG';

export type StatutSessionEchange = 'ACTIVE' | 'FERMEE';

export interface AmqpChatHeaders {
  echange_id: string;
  type_message: TypeMessageChat;
  niveau_securite: NiveauSecurite;
  emetteur_id: string;
  correspondant_recepteur_id?: string;
  numero_sequence?: number;
  [key: string]: unknown;
}

export interface ProprietesMessageChatAmqp {
  content_type: 'application/json';
  delivery_mode: 2;
  correlation_id: string;
  type: TypeMessageChat;
  message_id: string;
  timestamp: string;
  headers: AmqpChatHeaders;
}

export type ProprietesPublicationChatAmqp = Partial<
  Omit<ProprietesMessageChatAmqp, 'correlation_id' | 'type' | 'headers'>
> & {
  correlation_id: string;
  type: TypeMessageChat;
  headers: AmqpChatHeaders;
};

export interface MessageChatPayload {
  echangeId: string;
  numeroSequence: number;
  typeMessage: TypeMessageChat;
  niveauSecurite: NiveauSecurite;
  emetteurId: string;
  correspondantRecepteurId: string;
  horodatage: string;
  contenu?: string;
  signature?: string;
  contenuChiffre?: string;
  numeroSerieCertificatSignature?: string;
  numeroSerieCertificatChiffrement?: string;
}

export interface EnveloppeChatAmqp {
  exchange: string;
  routingKey: string;
  payload: MessageChatPayload;
  rawBody: string;
  properties: ProprietesMessageChatAmqp;
}

export type ChatMessageHandler = (
  enveloppe: EnveloppeChatAmqp
) => void | Promise<void>;

export interface ChatAmqpTransport {
  publierMessageChat(
    correspondantRecepteurId: string,
    payload: MessageChatPayload,
    proprietes: ProprietesPublicationChatAmqp
  ): Promise<void>;
  abonnerBoiteReception(
    correspondantId: string,
    handler: ChatMessageHandler
  ): Promise<string>;
  desabonnerBoiteReception?(
    correspondantId: string,
    consumerTag: string
  ): boolean;
}

export interface SessionEchangeState {
  echangeId: string;
  correspondantDistantId: string;
  niveauSecurite: NiveauSecurite;
  statut: StatutSessionEchange;
  initiateurId: string;
  dernierNumeroSequenceEnvoye: number;
  dernierNumeroSequenceRecu: number;
  sequencesRecuesParEmetteur: Record<string, number>;
  certificatDistantSignatureNumeroSerie?: string;
  certificatDistantChiffrementNumeroSerie?: string;
  horodatageOuverture: string;
  horodatageCloture?: string;
}

export interface MessageEnvoye {
  echangeId: string;
  numeroSequence: number;
  typeMessage: TypeMessageChat;
  niveauSecurite: NiveauSecurite;
  emetteurId: string;
  correspondantRecepteurId: string;
  horodatage: string;
  sessionFermee: boolean;
}

export interface MessageRecu {
  echangeId: string;
  numeroSequence: number;
  typeMessage: TypeMessageChat;
  niveauSecurite: NiveauSecurite;
  emetteurId: string;
  correspondantRecepteurId: string;
  contenu: string;
  horodatage: string;
  sessionFermee: boolean;
}

export interface ErreurReceptionChat {
  erreur: Error;
  enveloppe: EnveloppeChatAmqp;
  horodatage: string;
}

export interface CorrespondantClientConfig {
  correspondantId: string;
  natureRessource?: NatureRessource;
  transport: ChatAmqpTransport;
  utilisateurIcp: UtilisateurIcpClient;
  certificat?: Certificat;
  clePrivee?: string;
  certificatSignature?: Certificat;
  clePriveeSignature?: string;
  certificatChiffrement?: Certificat;
  clePriveeChiffrement?: string;
  horloge?: () => Date;
  autoAbonnement?: boolean;
}

export interface OptionsOuvertureEchange {
  echangeId?: string;
  numeroSerieCertificatCorrespondantRecepteur?: string;
  numeroSerieCertificatSignatureCorrespondantRecepteur?: string;
  numeroSerieCertificatChiffrementCorrespondantRecepteur?: string;
}

export interface OptionsEnvoiMessage {
  niveauSecurite?: NiveauSecurite;
}
