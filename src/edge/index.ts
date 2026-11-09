import { InMemoryJmsBroker } from '../broker/index.js';
import { bootstrapHierarchieAc } from '../ac/index.js';
import { ServicePublication } from '../annuaire/index.js';
import { bootstrapAutoritesEnregistrement } from '../ae/index.js';
import { bootstrapAutoritesValidation } from '../av/index.js';

import { ServiceDiscoveryRegistry } from './discovery.js';
import { ConfigurationServer } from './config-server.js';
import { ApiGateway } from './api-gateway.js';
import { MessagingEdgeGateway } from './messaging-gateway.js';

export * from './types.js';
export * from './errors.js';
export * from './discovery.js';
export * from './config-server.js';
export * from './rate-limiter.js';
export * from './api-gateway.js';
export * from './messaging-gateway.js';

export interface EdgeEnvironment {
  broker: InMemoryJmsBroker;
  discovery: ServiceDiscoveryRegistry;
  configServer: ConfigurationServer;
  apiGateway: ApiGateway;
  messagingGateway: MessagingEdgeGateway;
  annuaire: ServicePublication;
}

/**
 * Convenience bootstrapper for the complete Edge layer and internal PKI
 */
export function bootstrapEdgeEnvironment(
  customBroker?: InMemoryJmsBroker
): EdgeEnvironment {
  const broker = customBroker ?? new InMemoryJmsBroker();
  const annuaire = new ServicePublication(broker);
  const acHierarchy = bootstrapHierarchieAc(broker);

  // Discovery registry
  const discovery = new ServiceDiscoveryRegistry();
  discovery.registerAnnuaire(annuaire);

  // Configuration Server
  const configServer = new ConfigurationServer();
  configServer.loadFromHierarchy(acHierarchy);

  // Bootstrapping AE and AV for baseline natures
  const aeManager = bootstrapAutoritesEnregistrement(broker, annuaire);
  const avManager = bootstrapAutoritesValidation(broker, annuaire);

  const baselineNatures = ['messagerie', 'routeurs', 'services', 'utilisateurs'] as const;
  for (const nature of baselineNatures) {
    const ae = aeManager.getAeParNature(nature);
    const av = avManager.getAvParNature(nature);
    discovery.registerNaturePair({ nature, ae, av });
  }

  // API Gateway
  const apiGateway = new ApiGateway({
    discovery,
    configServer,
  });

  // Messaging Edge Gateway
  const messagingGateway = new MessagingEdgeGateway({
    broker,
    enforceInboxIsolation: true,
  });

  return {
    broker,
    discovery,
    configServer,
    apiGateway,
    messagingGateway,
    annuaire,
  };
}
