import type {
  AutoriteEnregistrement,
} from '../ae/index.js';
import type {
  AutoriteValidation,
} from '../av/index.js';
import type {
  ServicePublication,
} from '../annuaire/index.js';
import type {
  AutoriteCertification,
} from '../ac/index.js';
import type {
  Certificat,
  AutoriteCertificationInfo,
  RestRequest,
  RestResponse,
} from '../types/index.js';

export type ServiceType = 'AE' | 'AV' | 'ANNUAIRE' | (string & {});

export interface ServiceInstance<T = any> {
  id: string;
  type: ServiceType;
  nature?: string;
  instance: T;
  metadata?: Record<string, any>;
  registeredAt: string;
}

export interface RegisterServiceOptions<T = any> {
  id: string;
  type: ServiceType;
  instance: T;
  nature?: string;
  metadata?: Record<string, any>;
}

export interface RegisterNaturePairOptions {
  nature: string;
  ae: AutoriteEnregistrement;
  av: AutoriteValidation;
  metadata?: Record<string, any>;
}

export interface CaTopologyNode {
  acId: string;
  nomOrganisationnel: string;
  niveau: number;
  acParenteId: string | null;
  certificatAc?: Certificat;
  jmsQueueDemandes: string;
  dureeValiditeAnnees?: number;
}

export interface ConfigurationServerOptions {
  rootCa?: AutoriteCertification | Certificat | AutoriteCertificationInfo;
  initialTopology?: CaTopologyNode[];
  initialNatures?: string[];
}

export interface RateLimitOptions {
  windowMs: number;
  maxRequests: number;
  keyGenerator?: (req: RestRequest) => string;
}

export interface ApiGatewayOptions {
  discovery: import('./discovery.js').ServiceDiscoveryRegistry;
  configServer?: import('./config-server.js').ConfigurationServer;
  rateLimitOptions?: Partial<RateLimitOptions>;
  enforceTls?: boolean;
}

export interface ClientContext {
  clientId?: string;
  role?: string;
}
