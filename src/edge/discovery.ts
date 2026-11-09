import type { AutoriteEnregistrement } from '../ae/index.js';
import type { AutoriteValidation } from '../av/index.js';
import type { ServicePublication } from '../annuaire/index.js';
import type {
  ServiceType,
  ServiceInstance,
  RegisterServiceOptions,
  RegisterNaturePairOptions,
} from './types.js';

export type ServiceRegistryListener = (
  event: 'REGISTERED' | 'UNREGISTERED',
  service: ServiceInstance
) => void;

export class ServiceDiscoveryRegistry {
  private services = new Map<string, ServiceInstance>();
  private listeners = new Set<ServiceRegistryListener>();

  public register<T = any>(options: RegisterServiceOptions<T>): ServiceInstance<T> {
    const service: ServiceInstance<T> = {
      id: options.id,
      type: options.type,
      nature: options.nature,
      instance: options.instance,
      metadata: options.metadata ?? {},
      registeredAt: new Date().toISOString(),
    };

    this.services.set(options.id, service);
    this.notifyListeners('REGISTERED', service);
    return service;
  }

  public unregister(id: string): boolean {
    const service = this.services.get(id);
    if (!service) {
      return false;
    }
    this.services.delete(id);
    this.notifyListeners('UNREGISTERED', service);
    return true;
  }

  public registerAe(ae: AutoriteEnregistrement, id?: string): ServiceInstance<AutoriteEnregistrement> {
    const serviceId = id ?? `ae-${ae.nature}-${ae.id}`;
    return this.register<AutoriteEnregistrement>({
      id: serviceId,
      type: 'AE',
      nature: ae.nature,
      instance: ae,
      metadata: { aeId: ae.id },
    });
  }

  public registerAv(av: AutoriteValidation, id?: string): ServiceInstance<AutoriteValidation> {
    const serviceId = id ?? `av-${av.nature}-${av.id}`;
    return this.register<AutoriteValidation>({
      id: serviceId,
      type: 'AV',
      nature: av.nature,
      instance: av,
      metadata: { avId: av.id },
    });
  }

  public registerAnnuaire(
    annuaire: ServicePublication,
    id: string = 'annuaire-publication'
  ): ServiceInstance<ServicePublication> {
    return this.register<ServicePublication>({
      id,
      type: 'ANNUAIRE',
      instance: annuaire,
    });
  }

  public registerNaturePair(options: RegisterNaturePairOptions): {
    aeService: ServiceInstance<AutoriteEnregistrement>;
    avService: ServiceInstance<AutoriteValidation>;
  } {
    const aeService = this.registerAe(options.ae, `ae-${options.nature}-${options.ae.id}`);
    const avService = this.registerAv(options.av, `av-${options.nature}-${options.av.id}`);
    return { aeService, avService };
  }

  public getService<T = any>(id: string): ServiceInstance<T> | undefined {
    return this.services.get(id) as ServiceInstance<T> | undefined;
  }

  public findServices<T = any>(query: {
    type?: ServiceType;
    nature?: string;
  }): ServiceInstance<T>[] {
    const results: ServiceInstance<T>[] = [];
    for (const service of this.services.values()) {
      if (query.type && service.type !== query.type) {
        continue;
      }
      if (query.nature && service.nature !== query.nature) {
        continue;
      }
      results.push(service as ServiceInstance<T>);
    }
    return results;
  }

  public getAe(nature: string): AutoriteEnregistrement | undefined {
    const match = this.findServices<AutoriteEnregistrement>({
      type: 'AE',
      nature,
    });
    return match.length > 0 ? match[0].instance : undefined;
  }

  public getAv(nature: string): AutoriteValidation | undefined {
    const match = this.findServices<AutoriteValidation>({
      type: 'AV',
      nature,
    });
    return match.length > 0 ? match[0].instance : undefined;
  }

  public getAnnuaire(): ServicePublication | undefined {
    const match = this.findServices<ServicePublication>({
      type: 'ANNUAIRE',
    });
    return match.length > 0 ? match[0].instance : undefined;
  }

  public listServices(): ServiceInstance[] {
    return Array.from(this.services.values());
  }

  public listNatures(): string[] {
    const natures = new Set<string>();
    for (const service of this.services.values()) {
      if (service.nature) {
        natures.add(service.nature);
      }
    }
    return Array.from(natures);
  }

  public addListener(listener: ServiceRegistryListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private notifyListeners(
    event: 'REGISTERED' | 'UNREGISTERED',
    service: ServiceInstance
  ): void {
    for (const listener of this.listeners) {
      try {
        listener(event, service);
      } catch {
        // Safe guard against listener errors
      }
    }
  }

  public clear(): void {
    this.services.clear();
  }
}
