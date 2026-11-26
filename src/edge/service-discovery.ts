import type { AutoriteEnregistrement } from '../ae/index.js';
import type { ServicePublication } from '../annuaire/index.js';
import type { AutoriteValidation } from '../av/index.js';
import type { NatureRessource } from '../types/index.js';

export interface ServicesNature {
  ae?: AutoriteEnregistrement;
  av?: AutoriteValidation;
}

/**
 * Registre dynamique Edge (Service Discovery) référençant les instances d'AE et d'AV
 * par nature de Ressource ainsi que le Service de Publication.
 */
export class ServiceDiscovery {
  private readonly aes = new Map<NatureRessource, AutoriteEnregistrement>();
  private readonly avs = new Map<NatureRessource, AutoriteValidation>();
  private annuaire: ServicePublication | undefined;

  enregistrerAnnuaire(annuaire: ServicePublication): void {
    this.annuaire = annuaire;
  }

  enregistrerAe(ae: AutoriteEnregistrement): void;
  enregistrerAe(nature: NatureRessource, ae: AutoriteEnregistrement): void;
  enregistrerAe(
    natureOrAe: NatureRessource | AutoriteEnregistrement,
    ae?: AutoriteEnregistrement
  ): void {
    if (typeof natureOrAe === 'string') {
      if (!ae) {
        throw new Error(`Instance AE requise pour la nature "${natureOrAe}".`);
      }
      this.aes.set(natureOrAe, ae);
      return;
    }
    this.aes.set(natureOrAe.nature, natureOrAe);
  }

  enregistrerAv(av: AutoriteValidation): void;
  enregistrerAv(nature: NatureRessource, av: AutoriteValidation): void;
  enregistrerAv(
    natureOrAv: NatureRessource | AutoriteValidation,
    av?: AutoriteValidation
  ): void {
    if (typeof natureOrAv === 'string') {
      if (!av) {
        throw new Error(`Instance AV requise pour la nature "${natureOrAv}".`);
      }
      this.avs.set(natureOrAv, av);
      return;
    }
    this.avs.set(natureOrAv.nature, natureOrAv);
  }

  enregistrerNature(nature: NatureRessource, services: ServicesNature): void {
    if (services.ae) {
      this.aes.set(nature, services.ae);
    }
    if (services.av) {
      this.avs.set(nature, services.av);
    }
  }

  resoudreAe(nature: NatureRessource): AutoriteEnregistrement | undefined {
    return this.aes.get(nature);
  }

  resoudreAv(nature: NatureRessource): AutoriteValidation | undefined {
    return this.avs.get(nature);
  }

  resoudreAnnuaire(): ServicePublication | undefined {
    return this.annuaire;
  }

  listerNatures(): NatureRessource[] {
    return Array.from(new Set<NatureRessource>([...this.aes.keys(), ...this.avs.keys()]));
  }
}
