import type { InMemoryJmsBroker } from '../broker/index.js';
import type { ServicePublication } from '../annuaire/index.js';
import type {
  AutoriteValidation,
  ServiceAutoriteValidation,
} from '../av/index.js';

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
  signature?: string | null;
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
  interlocuteurCertificatNumeroSerie?: string | null;
  interlocuteurCertificatChiffrementNumeroSerie?: string | null;
}

export interface InitialiserEchangeOptions {
  niveauSecurite?: NiveauSecurite;
  premierMessage?: string;
  echangeId?: string;
  destinataireCertificatNumeroSerie?: string;
  destinataireCertificatChiffrementNumeroSerie?: string;
}

export interface EnvoyerMessageOptions {
  numeroSequence?: number;
  niveauSecurite?: NiveauSecurite;
  typeMessage?: TypeMessageChat;
}

export type MessageChatListener = (message: MessageChat) => void;

export interface CorrespondantClientConfig {
  id: string;
  broker: InMemoryJmsBroker;
  certificatNumeroSerie?: string;
  clePriveePem?: string;
  clePubliquePem?: string;
  certificatChiffrementNumeroSerie?: string;
  clePriveeChiffrementPem?: string;
  annuaire?: ServicePublication;
  av?: AutoriteValidation | ServiceAutoriteValidation;
}
