import type { RestRequest } from '../types/index.js';
import type { RateLimitOptions } from './types.js';

export interface RateLimitCheckResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  remaining: number;
  resetMs: number;
}

export class RateLimiter {
  private windowMs: number;
  private maxRequests: number;
  private keyGenerator: (req: RestRequest) => string;
  private requestsByKey = new Map<string, number[]>();

  constructor(options?: Partial<RateLimitOptions>) {
    this.windowMs = options?.windowMs ?? 60_000;
    this.maxRequests = options?.maxRequests ?? 5;
    this.keyGenerator =
      options?.keyGenerator ??
      ((req: RestRequest) => {
        const headers = req.headers ?? {};
        let ip: string | undefined = undefined;
        for (const [key, value] of Object.entries(headers)) {
          const lower = key.toLowerCase();
          if (
            (lower === 'x-forwarded-for' ||
              lower === 'x-real-ip' ||
              lower === 'x-client-id') &&
            value
          ) {
            ip = String(value);
            break;
          }
        }
        if (ip) return ip;

        const body = req.body as any;
        if (body?.nomEntite) return `entity:${body.nomEntite}`;

        return 'anonymous';
      });
  }

  public setOptions(options: Partial<RateLimitOptions>): void {
    if (options.windowMs !== undefined) this.windowMs = options.windowMs;
    if (options.maxRequests !== undefined) this.maxRequests = options.maxRequests;
    if (options.keyGenerator !== undefined) this.keyGenerator = options.keyGenerator;
  }

  public getLimit(): number {
    return this.maxRequests;
  }

  public getWindowMs(): number {
    return this.windowMs;
  }

  public extractKey(req: RestRequest): string {
    return this.keyGenerator(req);
  }

  public check(key: string, now: number = Date.now()): RateLimitCheckResult {
    let timestamps = this.requestsByKey.get(key) ?? [];
    const windowStart = now - this.windowMs;

    // Filter out timestamps outside the sliding window
    timestamps = timestamps.filter((t) => t > windowStart);
    this.requestsByKey.set(key, timestamps);

    const currentCount = timestamps.length;
    const remaining = Math.max(0, this.maxRequests - currentCount);
    const oldestTimestamp = timestamps.length > 0 ? timestamps[0] : now;
    const resetMs = Math.max(0, oldestTimestamp + this.windowMs - now);

    return {
      allowed: currentCount < this.maxRequests,
      currentCount,
      limit: this.maxRequests,
      remaining,
      resetMs,
    };
  }

  public record(key: string, now: number = Date.now()): RateLimitCheckResult {
    const status = this.check(key, now);
    if (status.allowed) {
      const timestamps = this.requestsByKey.get(key)!;
      timestamps.push(now);
      return {
        allowed: true,
        currentCount: timestamps.length,
        limit: this.maxRequests,
        remaining: Math.max(0, this.maxRequests - timestamps.length),
        resetMs: status.resetMs,
      };
    }
    return status;
  }

  public reset(key?: string): void {
    if (key) {
      this.requestsByKey.delete(key);
    } else {
      this.requestsByKey.clear();
    }
  }
}
