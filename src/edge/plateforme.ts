import { amorcerHierarchieAc, type HierarchieAc } from '../ac/index.js';
import { AutoriteEnregistrement } from '../ae/index.js';
import { InMemoryAmqpBroker } from '../amqp/index.js';
import { ServicePublication } from '../annuaire/index.js';
import { AutoriteValidation } from '../av/index.js';
import type { EntiteAEInscription } from '../types/index.js';
import { ApiGateway } from './api-gateway.js';
import { ConfigurationServer } from './config-server.js';
import { PasserelleEdgeMessagerie } from './passerelle-messagerie.js';
import { RateLimiter } from './rate-limiter.js';
import { ServiceDiscovery } from './service-discovery.js';

export const NATURES_RESSOURCES_DEFAUT = [
  'messagerie',
  'routeurs',
  'services',
  'utilisateurs'
] as const;

export type NatureRessourceDefaut = (typeof NATURES_RESSOURCES_DEFAUT)[number];

export interface OptionsPlateformeComplete {
  entitesParNature?: Partial<Record<NatureRessourceDefaut, EntiteAEInscription[]>>;
  exigerTls?: boolean;
  rateLimit?: {
    limiteRequetes?: number;
    fenetreMs?: number;
  };
  delaiReponseAcMs?: number;
  activerCache?: boolean;
  horloge?: () => Date;
}

export interface PlateformeComplete {
  broker: InMemoryAmqpBroker;
  annuaire: ServicePublication;
  hierarchie: HierarchieAc;
  aes: Record<NatureRessourceDefaut, AutoriteEnregistrement>;
  avs: Record<NatureRessourceDefaut, AutoriteValidation>;
  serviceDiscovery: ServiceDiscovery;
  configurationServer: ConfigurationServer;
  rateLimiter: RateLimiter;
  apiGateway: ApiGateway;
  passerelleMessagerie: PasserelleEdgeMessagerie;
  arreter: () => Promise<void>;
}

/**
 * Assemble et démarre l'ensemble de la plateforme ICP hiérarchique 3 niveaux,
 * le Service de Publication, les AE/AV par nature de Ressource et les 4 micro-services Edge.
 */
export async function creerPlateformeComplete(
  options: OptionsPlateformeComplete = {}
): Promise<PlateformeComplete> {
  const broker = new InMemoryAmqpBroker();
  const annuaire = new ServicePublication(broker, {
    ...(options.horloge ? { horloge: options.horloge } : {})
  });
  await annuaire.ready();

  // Les AV doivent être abonnées avant l'amorçage de la hiérarchie d'AC
  // afin de recevoir les certificats d'AC et les LCR initiales via ex.pki.publications.
  const avEntries = await Promise.all(
    NATURES_RESSOURCES_DEFAUT.map(async (nature) => {
      const av = new AutoriteValidation({
        nature,
        broker,
        ...(options.horloge ? { horloge: options.horloge } : {})
      });
      await av.ready();
      return [nature, av] as const;
    })
  );
  const avs = Object.fromEntries(avEntries) as Record<
    NatureRessourceDefaut,
    AutoriteValidation
  >;

  const hierarchie = await amorcerHierarchieAc(broker, {
    ...(options.horloge ? { horloge: options.horloge } : {})
  });

  const aeEntries = await Promise.all(
    NATURES_RESSOURCES_DEFAUT.map(async (nature) => {
      const ae = new AutoriteEnregistrement({
        nature,
        broker,
        servicePublication: annuaire,
        entites: options.entitesParNature?.[nature] ?? [],
        ...(options.delaiReponseAcMs !== undefined
          ? { delaiReponseAcMs: options.delaiReponseAcMs }
          : {})
      });
      await ae.ready();
      return [nature, ae] as const;
    })
  );
  const aes = Object.fromEntries(aeEntries) as Record<
    NatureRessourceDefaut,
    AutoriteEnregistrement
  >;

  const serviceDiscovery = new ServiceDiscovery();
  serviceDiscovery.enregistrerAnnuaire(annuaire);
  for (const nature of NATURES_RESSOURCES_DEFAUT) {
    serviceDiscovery.enregistrerNature(nature, {
      ae: aes[nature],
      av: avs[nature]
    });
  }

  const configurationServer = new ConfigurationServer({
    hierarchie,
    ...(options.horloge ? { horloge: options.horloge } : {})
  });

  const rateLimiter = new RateLimiter({
    ...options.rateLimit,
    ...(options.horloge ? { horloge: options.horloge } : {})
  });

  const apiGateway = new ApiGateway({
    serviceDiscovery,
    configurationServer,
    exigerTls: options.exigerTls,
    rateLimiter,
    activerCache: options.activerCache,
    ...(options.horloge ? { horloge: options.horloge } : {})
  });

  const passerelleMessagerie = new PasserelleEdgeMessagerie(broker);

  const arreter = async (): Promise<void> => {
    await Promise.all([
      ...Object.values(aes).map((ae) => ae.arreter()),
      ...Object.values(avs).map((av) => av.arreter()),
      annuaire.arreter()
    ]);
    for (const ac of hierarchie.autorites.values()) {
      if (ac.niveau === 3) {
        ac.suspendreConsommation();
      }
    }
  };

  return {
    broker,
    annuaire,
    hierarchie,
    aes,
    avs,
    serviceDiscovery,
    configurationServer,
    rateLimiter,
    apiGateway,
    passerelleMessagerie,
    arreter
  };
}
