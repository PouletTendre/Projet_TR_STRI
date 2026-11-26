export interface RateLimiterConfig {
  limiteRequetes?: number;
  fenetreMs?: number;
  horloge?: () => Date;
}

export interface ResultatRateLimit {
  autorise: boolean;
  restant: number;
  limite: number;
  reinitialisationMs: number;
}

/**
 * Limiteur de débit par fenêtre glissante pour protéger les endpoints AE sensibles
 * (`POST /ae/{nature}/demandes-certification` et `POST /ae/{nature}/demandes-revocation`).
 */
export class RateLimiter {
  readonly limiteRequetes: number;
  readonly fenetreMs: number;

  private readonly horloge: () => Date;
  private readonly historiques = new Map<string, number[]>();

  constructor(config: RateLimiterConfig = {}) {
    this.limiteRequetes = config.limiteRequetes ?? 30;
    this.fenetreMs = config.fenetreMs ?? 60_000;
    this.horloge = config.horloge ?? (() => new Date());
  }

  verifierEtConsommer(cle: string): ResultatRateLimit {
    const maintenantMs = this.horloge().getTime();
    const seuilMs = maintenantMs - this.fenetreMs;

    const precedents = (this.historiques.get(cle) ?? []).filter((ts) => ts > seuilMs);

    if (precedents.length >= this.limiteRequetes) {
      this.historiques.set(cle, precedents);
      const plusAncien = precedents[0] ?? maintenantMs;
      return {
        autorise: false,
        restant: 0,
        limite: this.limiteRequetes,
        reinitialisationMs: Math.max(0, plusAncien + this.fenetreMs - maintenantMs)
      };
    }

    precedents.push(maintenantMs);
    this.historiques.set(cle, precedents);

    const plusAncien = precedents[0] ?? maintenantMs;
    return {
      autorise: true,
      restant: Math.max(0, this.limiteRequetes - precedents.length),
      limite: this.limiteRequetes,
      reinitialisationMs: Math.max(0, plusAncien + this.fenetreMs - maintenantMs)
    };
  }

  reinitialiser(cle?: string): void {
    if (cle === undefined) {
      this.historiques.clear();
      return;
    }
    this.historiques.delete(cle);
  }
}
