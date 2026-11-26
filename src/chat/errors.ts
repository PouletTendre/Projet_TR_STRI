import type { ValidationCertificatReponse } from '../types/index.js';

/**
 * Erreur métier racine du sous-système de messagerie texte sécurisée.
 */
export class ErreurMessagerie extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = new.target.name;
    this.code = code;
  }
}

/**
 * Erreur levée lorsque la validation en 4 étapes ou le contrôle dynamique AV
 * d'un Certificat (propre ou distant) échoue avant ou pendant un Échange.
 */
export class ErreurValidationCorrespondant extends ErreurMessagerie {
  readonly rapportValidation?: ValidationCertificatReponse;

  constructor(
    code: string,
    message: string,
    rapportValidation?: ValidationCertificatReponse
  ) {
    super(code, message);
    this.rapportValidation = rapportValidation;
  }
}

/**
 * Erreur levée en cas d'atteinte à la politique cryptographique ou à l'intégrité
 * d'un Échange (changement/rétrogradation de niveau, signature invalide, déchiffrement impossible).
 */
export class ErreurSecuriteEchange extends ErreurMessagerie {}

/**
 * Erreur levée lorsqu'une opération porte sur une session fermée (après FIN_MSG)
 * ou inexistante / déjà ouverte.
 */
export class ErreurSessionFermee extends ErreurMessagerie {}

/**
 * Erreur levée lorsqu'un numéro de séquence est non monotone, rejoué ou incohérent
 * avec l'état d'initialisation de la session.
 */
export class ErreurSequenceMessage extends ErreurMessagerie {}
