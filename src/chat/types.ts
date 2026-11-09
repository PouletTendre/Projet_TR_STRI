export type NiveauSecurite =
  | 'NON_SECURISE'
  | 'SIGNE'
  | 'CHIFFRE'
  | 'SIGNE_ET_CHIFFRE';

export type TypeMessageChat = 'INIT_ECHANGE' | 'MSG_TEXTE' | 'FIN_MSG';

export type EtatEchange = 'ACTIF' | 'TERMINE';

export interface MessageChat {
  echangeId: string;
  numeroSequence: number;
  typeMessage: TypeMessageChat;
  niveauSecurite: NiveauSecurite;
  expediteurId: string;
  destinataireId: string;
  texte: string;
  horodatage: string;
  numeroSerieCertExpediteur?: string | null;
  numeroSerieCertDestinataire?: string | null;
}

export interface EchangeSession {
  echangeId: string;
  interlocuteurId: string;
  expediteurInitialId: string;
  niveauSecurite: NiveauSecurite;
  etat: EtatEchange;
  dernierNumeroSequence: number;
  dateCreation: string;
  dateCloture?: string;
  messages: MessageChat[];
}

export interface InitialiserEchangeOptions {
  niveauSecurite?: NiveauSecurite;
  premierMessage?: string;
  echangeId?: string;
}

export interface EnvoyerMessageOptions {
  numeroSequence?: number;
  niveauSecurite?: NiveauSecurite;
  typeMessage?: TypeMessageChat;
}

export type MessageChatListener = (message: MessageChat) => void;
