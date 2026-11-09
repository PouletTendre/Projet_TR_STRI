import type {
  RestRequest,
  RestResponse,
  ErreurApi,
} from '../types/index.js';
import { ServiceDiscoveryRegistry } from './discovery.js';
import { ConfigurationServer } from './config-server.js';
import { RateLimiter } from './rate-limiter.js';
import type { ApiGatewayOptions, RateLimitOptions } from './types.js';

export class ApiGateway {
  public readonly discovery: ServiceDiscoveryRegistry;
  public readonly configServer?: ConfigurationServer;
  public readonly rateLimiter: RateLimiter;
  public readonly enforceTls: boolean;
  private edgeCache = new Map<string, { body: any; status: number; expiresAt: number }>();
  private cacheTtlMs: number = 30_000;

  constructor(options: ApiGatewayOptions) {
    this.discovery = options.discovery;
    this.configServer = options.configServer;
    this.rateLimiter = new RateLimiter(options.rateLimitOptions);
    this.enforceTls = options.enforceTls ?? false;
  }

  public setRateLimitOptions(options: Partial<RateLimitOptions>): void {
    this.rateLimiter.setOptions(options);
  }

  public resetRateLimits(): void {
    this.rateLimiter.reset();
  }

  public clearCache(): void {
    this.edgeCache.clear();
  }

  public async handleRequest(req: RestRequest): Promise<RestResponse> {
    // 0. TLS Enforcement Check
    if (this.enforceTls) {
      const forwardedProto =
        req.headers?.['x-forwarded-proto'] ?? req.headers?.['X-Forwarded-Proto'];
      if (!forwardedProto || String(forwardedProto).toLowerCase() !== 'https') {
        const err: ErreurApi = {
          code: 'TLS_REQUIS',
          message:
            "Connexion sécurisée requise : l'en-tête X-Forwarded-Proto doit être 'https'.",
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 403,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
    }

    const cleanPath = req.path.split('?')[0].replace(/\/+$/, '');

    // 1. Rate Limiting Check on Sensitive Endpoints
    if (this.isSensitiveEndpoint(req.method, cleanPath)) {
      const clientKey = this.rateLimiter.extractKey(req);
      const rateStatus = this.rateLimiter.record(clientKey);

      if (!rateStatus.allowed) {
        const err: ErreurApi = {
          code: 'RATE_LIMIT_EXCEEDED',
          message:
            'Limite de requêtes atteinte (rate limit exceeded). Veuillez réessayer ultérieurement.',
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        const retryAfterSeconds = Math.max(1, Math.ceil(rateStatus.resetMs / 1000));
        return {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': String(retryAfterSeconds),
            'X-RateLimit-Limit': String(rateStatus.limit),
            'X-RateLimit-Remaining': String(rateStatus.remaining),
            'X-RateLimit-Reset': String(retryAfterSeconds),
          },
          body: err,
        };
      }
    }

    // 2. Cache lookup for cacheable GET requests (e.g. annuaire certification chains)
    if (req.method === 'GET' && this.isCacheablePath(cleanPath)) {
      const cached = this.edgeCache.get(cleanPath);
      if (cached && cached.expiresAt > Date.now()) {
        return {
          status: cached.status,
          headers: {
            'Content-Type': 'application/json',
            'X-Cache': 'HIT',
          },
          body: cached.body,
        };
      }
    }

    // 3. Routing: /ae/{nature}/...
    const aeMatch = cleanPath.match(/^\/ae\/([^/]+)(\/.*)?$/);
    if (aeMatch) {
      const nature = aeMatch[1];
      const ae = this.discovery.getAe(nature);
      if (!ae) {
        const err: ErreurApi = {
          code: 'NATURE_NON_SUPPORTEE',
          message: `La nature '${nature}' n'est pas supportée ou aucune Autorité d'Enregistrement n'est enregistrée pour cette nature.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      return ae.handleRequest(req);
    }

    // 4. Routing: /av/{nature}/...
    const avMatch = cleanPath.match(/^\/av\/([^/]+)(\/.*)?$/);
    if (avMatch) {
      const nature = avMatch[1];
      const av = this.discovery.getAv(nature);
      if (!av) {
        const err: ErreurApi = {
          code: 'NATURE_NON_SUPPORTEE',
          message: `La nature '${nature}' n'est pas supportée ou aucune Autorité de Validation n'est enregistrée pour cette nature.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      return av.handleRequest(req);
    }

    // 5. Routing: /annuaire/...
    if (cleanPath === '/annuaire' || cleanPath.startsWith('/annuaire/')) {
      const annuaire = this.discovery.getAnnuaire();
      if (!annuaire) {
        const err: ErreurApi = {
          code: 'SERVICE_INDISPONIBLE',
          message: "Le Service de Publication (Annuaire) n'est pas disponible.",
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      const response = annuaire.handleRequest(req);
      if (response.status === 200 && req.method === 'GET' && this.isCacheablePath(cleanPath)) {
        this.edgeCache.set(cleanPath, {
          body: response.body,
          status: response.status,
          expiresAt: Date.now() + this.cacheTtlMs,
        });
      }
      return response;
    }

    // 6. Routing: /config/...
    if (cleanPath === '/config' || cleanPath.startsWith('/config/')) {
      if (!this.configServer) {
        const err: ErreurApi = {
          code: 'SERVICE_INDISPONIBLE',
          message: "Le Configuration Server n'est pas configuré sur l'API Gateway.",
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 503,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      return this.configServer.handleRequest(req);
    }

    // 7. Fallback: 404 Not Found
    const notFound: ErreurApi = {
      code: 'RESSOURCE_INTROUVABLE',
      message: `Ressource introuvable : ${req.method} ${cleanPath}`,
      horodatage: new Date().toISOString(),
      chemin: req.path,
    };
    return {
      status: 404,
      headers: { 'Content-Type': 'application/json' },
      body: notFound,
    };
  }

  private isSensitiveEndpoint(method: string, path: string): boolean {
    if (method !== 'POST') return false;
    return (
      /^\/ae\/[^/]+\/demandes-certification$/.test(path) ||
      /^\/ae\/[^/]+\/demandes-revocation$/.test(path)
    );
  }

  private isCacheablePath(path: string): boolean {
    return (
      /^\/annuaire\/certificats\/[^/]+\/chemin-certification$/.test(path) ||
      path === '/config/racine'
    );
  }
}
