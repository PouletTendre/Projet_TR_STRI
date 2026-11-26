import type { ErreurApi, RestResponse } from '../types/index.js';

/**
 * Construit une réponse d'erreur REST normalisée conforme au contrat `ErreurApi`.
 */
export function buildRestError(
  status: number,
  code: string,
  message: string,
  chemin: string,
  horodatage = new Date().toISOString()
): RestResponse<ErreurApi> {
  return {
    status,
    body: {
      code,
      message,
      horodatage,
      chemin
    }
  };
}

/**
 * Normalise un chemin REST en supprimant la chaîne de requête, le préfixe `/api/v1`
 * et tout slash final superflu.
 */
export function normalizeRestPath(rawPath: string): string {
  const [pathOnly] = rawPath.split('?', 2);
  let normalized = pathOnly ?? '/';
  if (normalized.startsWith('/api/v1')) {
    normalized = normalized.slice('/api/v1'.length) || '/';
  }
  if (normalized.length > 1 && normalized.endsWith('/')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

/**
 * Recherche un en-tête HTTP de manière insensible à la casse.
 */
export function getHeaderCaseInsensitive(
  headers: Record<string, string | undefined> | undefined,
  targetName: string
): string | undefined {
  if (!headers) {
    return undefined;
  }
  const lowerTarget = targetName.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lowerTarget) {
      return value;
    }
  }
  return undefined;
}
