import type { RestRequest, RestResponse, RestTransport } from '../types/index.js';
import type { ConfigurationServer } from './config-server.js';
import {
  buildRestError,
  getHeaderCaseInsensitive,
  normalizeRestPath
} from './http-utils.js';
import { RateLimiter } from './rate-limiter.js';
import type { ServiceDiscovery } from './service-discovery.js';

export interface ApiGatewayConfig {
  serviceDiscovery: ServiceDiscovery;
  configurationServer?: ConfigurationServer;
  exigerTls?: boolean;
  rateLimiter?: RateLimiter;
  activerCache?: boolean;
  horloge?: () => Date;
}

function isSensitiveAePostRoute(method: string, normalizedPath: string): boolean {
  if (method !== 'POST') {
    return false;
  }
  return (
    /^\/ae\/[^/]+\/demandes-certification$/.test(normalizedPath) ||
    /^\/ae\/[^/]+\/demandes-revocation$/.test(normalizedPath)
  );
}

function isCacheableGetRoute(method: string, normalizedPath: string): boolean {
  if (method !== 'GET') {
    return false;
  }
  return (
    normalizedPath === '/config/ancre-racine' ||
    /^\/annuaire\/certificats\/[^/]+\/chemin-certification$/.test(normalizedPath)
  );
}

function cloneResponse(res: RestResponse): RestResponse {
  return {
    status: res.status,
    body: res.body === undefined ? undefined : JSON.parse(JSON.stringify(res.body)),
    ...(res.headers ? { headers: { ...res.headers } } : {})
  };
}

/**
 * API Gateway Edge : point d'entrée REST unique routant `/ae/{nature}/...`,
 * `/av/{nature}/...`, `/annuaire/...` et `/config/...` via le `ServiceDiscovery`
 * et le `ConfigurationServer`, avec contrôle TLS optionnel, limitation de débit (429)
 * et mise en cache des réponses immuables (`X-Cache: MISS|HIT`).
 */
export class ApiGateway {
  private readonly serviceDiscovery: ServiceDiscovery;
  private readonly configurationServer: ConfigurationServer | undefined;
  private readonly exigerTls: boolean;
  private readonly rateLimiter: RateLimiter;
  private readonly activerCache: boolean;
  private readonly horloge: () => Date;
  private readonly cache = new Map<string, RestResponse>();

  constructor(config: ApiGatewayConfig) {
    this.serviceDiscovery = config.serviceDiscovery;
    this.configurationServer = config.configurationServer;
    this.exigerTls = config.exigerTls ?? false;
    this.rateLimiter = config.rateLimiter ?? new RateLimiter({ horloge: config.horloge });
    this.activerCache = config.activerCache ?? true;
    this.horloge = config.horloge ?? (() => new Date());
  }

  transport(defaultHeaders?: Record<string, string>): RestTransport {
    if (!defaultHeaders) {
      return (req: RestRequest) => this.handleRequest(req);
    }
    return (req: RestRequest) =>
      this.handleRequest({
        ...req,
        headers: {
          ...defaultHeaders,
          ...(req.headers ?? {})
        }
      });
  }

  viderCache(): void {
    this.cache.clear();
  }

  async handleRequest(req: RestRequest): Promise<RestResponse> {
    const nowIso = this.horloge().toISOString();

    if (this.exigerTls) {
      const proto = getHeaderCaseInsensitive(req.headers, 'x-forwarded-proto');
      if (proto?.trim().toLowerCase() !== 'https') {
        return buildRestError(
          403,
          'TLS_REQUIS',
          'Une connexion TLS (HTTPS) est obligatoire pour accéder à l’API Gateway.',
          req.path,
          nowIso
        );
      }
    }

    const method = req.method.toUpperCase();
    const normalizedPath = normalizeRestPath(req.path);

    if (isSensitiveAePostRoute(method, normalizedPath)) {
      const clientKey =
        getHeaderCaseInsensitive(req.headers, 'x-forwarded-for') ??
        getHeaderCaseInsensitive(req.headers, 'x-client-id') ??
        'client-defaut';
      const decision = this.rateLimiter.verifierEtConsommer(
        `${clientKey}:${normalizedPath}`
      );
      if (!decision.autorise) {
        const retryAfterSec = Math.max(1, Math.ceil(decision.reinitialisationMs / 1000));
        return {
          status: 429,
          headers: {
            'Retry-After': String(retryAfterSec),
            'X-RateLimit-Limit': String(decision.limite),
            'X-RateLimit-Remaining': '0'
          },
          body: {
            code: 'TROP_DE_REQUETES',
            message: `Limite de débit dépassée sur "${normalizedPath}". Réessayez ultérieurement.`,
            horodatage: nowIso,
            chemin: req.path
          }
        };
      }
    }

    const cacheable = this.activerCache && isCacheableGetRoute(method, normalizedPath);
    const cacheKey = `${method}:${normalizedPath}`;
    if (cacheable) {
      const cached = this.cache.get(cacheKey);
      if (cached) {
        const cloned = cloneResponse(cached);
        return {
          ...cloned,
          headers: {
            ...(cloned.headers ?? {}),
            'X-Cache': 'HIT'
          }
        };
      }
    }

    const response = await this.routerRequete(req, normalizedPath, nowIso);

    if (cacheable && response.status === 200) {
      this.cache.set(cacheKey, cloneResponse(response));
      return {
        ...response,
        headers: {
          ...(response.headers ?? {}),
          'X-Cache': 'MISS'
        }
      };
    }

    return response;
  }

  private async routerRequete(
    req: RestRequest,
    normalizedPath: string,
    nowIso: string
  ): Promise<RestResponse> {
    const aeMatch = /^\/ae\/([^/]+)(?:\/.*)?$/.exec(normalizedPath);
    if (aeMatch && aeMatch[1]) {
      const nature = decodeURIComponent(aeMatch[1]);
      const ae = this.serviceDiscovery.resoudreAe(nature);
      if (!ae) {
        return buildRestError(
          404,
          'NATURE_INTROUVABLE',
          `Aucune Autorité d'Enregistrement enregistrée pour la nature "${nature}".`,
          req.path,
          nowIso
        );
      }
      return ae.handleRestRequest(req);
    }

    const avMatch = /^\/av\/([^/]+)(?:\/.*)?$/.exec(normalizedPath);
    if (avMatch && avMatch[1]) {
      const nature = decodeURIComponent(avMatch[1]);
      const av = this.serviceDiscovery.resoudreAv(nature);
      if (!av) {
        return buildRestError(
          404,
          'NATURE_INTROUVABLE',
          `Aucune Autorité de Validation enregistrée pour la nature "${nature}".`,
          req.path,
          nowIso
        );
      }
      return av.handleRestRequest(req);
    }

    if (normalizedPath === '/annuaire' || normalizedPath.startsWith('/annuaire/')) {
      const annuaire = this.serviceDiscovery.resoudreAnnuaire();
      if (!annuaire) {
        return buildRestError(
          503,
          'SERVICE_INDISPONIBLE',
          'Aucun Service de Publication enregistré dans le Service Discovery.',
          req.path,
          nowIso
        );
      }
      return annuaire.handleRestRequest(req);
    }

    if (normalizedPath === '/config' || normalizedPath.startsWith('/config/')) {
      if (!this.configurationServer) {
        return buildRestError(
          404,
          'ROUTE_INTROUVABLE',
          'Aucun Configuration Server configuré sur cette API Gateway.',
          req.path,
          nowIso
        );
      }
      return this.configurationServer.handleRestRequest(req);
    }

    return buildRestError(
      404,
      'ROUTE_INTROUVABLE',
      `Ressource REST introuvable sur l’API Gateway : "${req.path}".`,
      req.path,
      nowIso
    );
  }
}
