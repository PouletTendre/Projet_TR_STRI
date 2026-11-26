import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const OPENAPI_PATH = resolve(REPO_ROOT, 'openapi', 'pki-api.yaml');
const DIAGRAMS_DIR = resolve(REPO_ROOT, 'docs', 'diagrams');

// Dynamically constructed so the test file itself never contains the forbidden literal.
const FORBIDDEN_LEGACY_PROTOCOL_REGEX = new RegExp(`${'j' + 'ms'}`, 'i');
const FORBIDDEN_LEGACY_DEST_REGEX = /\b(topic|queue)\.(pki|chat)\./i;
const FORBIDDEN_VENDOR_NAMES_REGEX =
  /\b(rabbitmq|activemq|kafka|kong|envoy|consul|eureka|spring|nginx|docker)\b/i;

const TECH_NEUTRAL_FORBIDDEN_PATTERNS: RegExp[] = [
  /\brest\b/i,
  /\bhttps?\b/i,
  /\b(get|post|put|delete)\b/i,
  /\b(200|201|202|401|403|404|409)\b/,
  /\bamqp\b/i,
  FORBIDDEN_LEGACY_PROTOCOL_REGEX,
  FORBIDDEN_LEGACY_DEST_REGEX,
  /\b(websocket|stomp)\b/i,
  /\b(queue|exchange|échangeur|echangeur|topic|broker|routing|binding)\b/i,
  /\b(openapi|json)\b/i,
  /\/(api|ae|av|annuaire)\//i,
  /\b(edge|gateway)\b/i,
  FORBIDDEN_VENDOR_NAMES_REGEX,
];

const EXPECTED_DIAGRAMS = [
  '01-cas-utilisation.puml',
  '02-architecture-blocs.puml',
  '03-hierarchie-ac.puml',
  '04-sequence-creation-certificat.puml',
  '05-sequence-revocation-suspension.puml',
  '06-sequence-validation-4-etapes.puml',
  '07-sequence-messagerie-securisee.puml',
  '08-architecture-amqp.puml',
  '09-microservices-edge.puml',
] as const;

const TECH_NEUTRAL_DIAGRAMS = EXPECTED_DIAGRAMS.slice(0, 7);

type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };

interface YamlLine {
  indent: number;
  text: string;
  raw: string;
}

function stripYamlComment(line: string): string {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i];
    if (ch === "'" && !inDouble) {
      inSingle = !inSingle;
    } else if (ch === '"' && !inSingle && line[i - 1] !== '\\') {
      inDouble = !inDouble;
    } else if (ch === '#' && !inSingle && !inDouble && (i === 0 || line[i - 1] === ' ')) {
      return line.slice(0, i).trimEnd();
    }
  }
  return line.trimEnd();
}

function parseScalar(raw: string): YamlValue {
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed === 'null' || trimmed === '~') return null;
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;
  if (/^-?\d+(\.\d+)?$/.test(trimmed)) return Number(trimmed);
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  if (trimmed === '{}') return {};
  if (trimmed === '[]') return [];
  return trimmed;
}

function splitKeyValue(text: string): [string, string] | null {
  let inSingle = false;
  let inDouble = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "'" && !inDouble) inSingle = !inSingle;
    else if (ch === '"' && !inSingle && text[i - 1] !== '\\') inDouble = !inDouble;
    else if (ch === ':' && !inSingle && !inDouble) {
      const next = text[i + 1];
      if (next === undefined || next === ' ') {
        const keyRaw = text.slice(0, i).trim();
        const key = String(parseScalar(keyRaw));
        const rest = text.slice(i + 1).trim();
        return [key, rest];
      }
    }
  }
  return null;
}

function parseYaml(source: string): Record<string, YamlValue> {
  const rawLines = source.split(/\r?\n/);
  const lines: YamlLine[] = [];
  for (const raw of rawLines) {
    const noComment = stripYamlComment(raw);
    if (noComment.trim().length === 0) continue;
    const indent = noComment.search(/\S/);
    lines.push({ indent, text: noComment.slice(indent), raw });
  }

  let idx = 0;

  function parseBlockScalar(parentIndent: number): string {
    const blockLines: string[] = [];
    let baseIndent: number | null = null;
    while (idx < lines.length) {
      const line = lines[idx];
      const rawIndent = line.raw.search(/\S/);
      if (rawIndent <= parentIndent) break;
      if (baseIndent === null) baseIndent = rawIndent;
      blockLines.push(line.raw.slice(baseIndent).trimEnd());
      idx += 1;
    }
    return blockLines.join('\n');
  }

  function parseNode(expectedIndent: number): YamlValue {
    if (idx >= lines.length) return null;
    const current = lines[idx];
    if (current.text.startsWith('- ') || current.text === '-') {
      return parseSequence(current.indent);
    }
    return parseMapping(expectedIndent);
  }

  function parseSequence(seqIndent: number): YamlValue[] {
    const items: YamlValue[] = [];
    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent < seqIndent) break;
      if (line.indent > seqIndent) break;
      if (!line.text.startsWith('- ') && line.text !== '-') break;

      const afterDash = line.text === '-' ? '' : line.text.slice(2).trim();
      idx += 1;

      if (afterDash === '') {
        if (idx < lines.length && lines[idx].indent > seqIndent) {
          items.push(parseNode(lines[idx].indent));
        } else {
          items.push(null);
        }
        continue;
      }

      const kv = splitKeyValue(afterDash);
      if (kv) {
        const obj: Record<string, YamlValue> = {};
        const itemIndent = seqIndent + 2;
        const [k, v] = kv;
        if (v === '|' || v === '>') {
          obj[k] = parseBlockScalar(itemIndent);
        } else if (v === '') {
          if (idx < lines.length && lines[idx].indent > itemIndent) {
            obj[k] = parseNode(lines[idx].indent);
          } else {
            obj[k] = null;
          }
        } else {
          obj[k] = parseScalar(v);
        }

        while (idx < lines.length && lines[idx].indent >= itemIndent) {
          if (lines[idx].indent > itemIndent) {
            break;
          }
          if (lines[idx].text.startsWith('- ')) break;
          const nextKv = splitKeyValue(lines[idx].text);
          if (!nextKv) break;
          const [nk, nv] = nextKv;
          idx += 1;
          if (nv === '|' || nv === '>') {
            obj[nk] = parseBlockScalar(itemIndent);
          } else if (nv === '') {
            if (idx < lines.length && lines[idx].indent > itemIndent) {
              obj[nk] = parseNode(lines[idx].indent);
            } else {
              obj[nk] = null;
            }
          } else {
            obj[nk] = parseScalar(nv);
          }
        }
        items.push(obj);
      } else {
        items.push(parseScalar(afterDash));
      }
    }
    return items;
  }

  function parseMapping(mapIndent: number): Record<string, YamlValue> {
    const obj: Record<string, YamlValue> = {};
    while (idx < lines.length) {
      const line = lines[idx];
      if (line.indent < mapIndent) break;
      if (line.text.startsWith('- ')) break;
      const kv = splitKeyValue(line.text);
      if (!kv) {
        idx += 1;
        continue;
      }
      const [key, valRaw] = kv;
      const keyIndent = line.indent;
      idx += 1;

      if (valRaw === '|' || valRaw === '>') {
        obj[key] = parseBlockScalar(keyIndent);
      } else if (valRaw === '') {
        if (idx < lines.length && lines[idx].indent > keyIndent) {
          obj[key] = parseNode(lines[idx].indent);
        } else {
          obj[key] = null;
        }
      } else {
        obj[key] = parseScalar(valRaw);
      }
    }
    return obj;
  }

  const result = parseMapping(lines[0]?.indent ?? 0);
  return result;
}

describe('Conformité documentaire — OpenAPI 3.0.3 & Diagrammes PlantUML', () => {
  describe('Spécification OpenAPI 3.0.3 (openapi/pki-api.yaml)', () => {
    const rawOpenApi = readFileSync(OPENAPI_PATH, 'utf8');
    const doc = parseYaml(rawOpenApi) as Record<string, any>;

    it('doit déclarer OpenAPI 3.0.3, les serveurs /api/v1 et le schéma BasicAuth sans aucun reliquat hérité', () => {
      expect(doc.openapi).toBe('3.0.3');
      expect(FORBIDDEN_LEGACY_PROTOCOL_REGEX.test(rawOpenApi)).toBe(false);
      expect(FORBIDDEN_LEGACY_DEST_REGEX.test(rawOpenApi)).toBe(false);

      const serverUrls = (doc.servers as Array<{ url: string }>).map((s) => s.url);
      expect(serverUrls).toEqual([
        'https://pki.organisation.internal/api/v1',
        'http://localhost:8080/api/v1',
      ]);

      expect(doc.components?.securitySchemes?.BasicAuth).toEqual({
        type: 'http',
        scheme: 'basic',
      });
    });

    it('ne doit plus exposer ni mentionner /av/{nature}/validations', () => {
      expect(doc.paths?.['/av/{nature}/validations']).toBeUndefined();
      expect(rawOpenApi).not.toMatch(/\/av\/\{nature\}\/validations/i);
    });

    it('doit exposer exactement les 11 opérations REST attendues (4 AE, 1 AV, 6 Service de Publication)', () => {
      const expectedOperations: Record<string, string[]> = {
        '/ae/{nature}/demandes-certification': ['post'],
        '/ae/{nature}/demandes-certification/{demandeId}': ['get'],
        '/ae/{nature}/demandes-revocation': ['post'],
        '/ae/{nature}/entites/{nomEntite}/droits': ['get'],
        '/av/{nature}/certificats/{numeroSerie}/statut': ['get'],
        '/annuaire/certificats': ['get'],
        '/annuaire/certificats/{numeroSerie}': ['get'],
        '/annuaire/certificats/{numeroSerie}/chemin-certification': ['get'],
        '/annuaire/autorites': ['get'],
        '/annuaire/autorites/{acId}/lcr': ['get'],
        '/annuaire/lcr': ['get'],
      };

      const actualPaths = Object.keys(doc.paths ?? {});
      expect(actualPaths.sort()).toEqual(Object.keys(expectedOperations).sort());

      let operationCount = 0;
      for (const [path, methods] of Object.entries(expectedOperations)) {
        const pathObj = doc.paths[path] ?? {};
        const actualMethods = Object.keys(pathObj).filter((k) =>
          ['get', 'post', 'put', 'delete', 'patch'].includes(k),
        );
        expect(actualMethods.sort()).toEqual(methods.sort());
        operationCount += actualMethods.length;
      }
      expect(operationCount).toBe(11);
    });

    it('doit définir les codes HTTP, en-têtes Location et sécurité BasicAuth / JSON sur les endpoints AE', () => {
      const postCert = doc.paths['/ae/{nature}/demandes-certification'].post;
      expect(Object.keys(postCert.responses).sort()).toEqual(['201', '202', '400', '401', '403', '404']);
      expect(postCert.responses['202'].headers?.Location).toBeDefined();

      const getDemande = doc.paths['/ae/{nature}/demandes-certification/{demandeId}'].get;
      expect(Object.keys(getDemande.responses).sort()).toEqual(['200', '404']);

      const postRevoc = doc.paths['/ae/{nature}/demandes-revocation'].post;
      expect(Object.keys(postRevoc.responses).sort()).toEqual(['200', '400', '401', '403', '404', '409']);

      const getDroits = doc.paths['/ae/{nature}/entites/{nomEntite}/droits'].get;
      expect(Object.keys(getDroits.responses).sort()).toEqual(['200', '401', '404']);
      expect(getDroits.security).toEqual([{ BasicAuth: [] }]);

      const certReqProps = doc.components?.schemas?.DemandeCertificationRequete?.properties ?? {};
      expect(certReqProps.nomEntite).toBeDefined();
      expect(certReqProps.motDePasse).toBeDefined();

      const revocReqProps = doc.components?.schemas?.DemandeRevocationRequete?.properties ?? {};
      expect(revocReqProps.nomEntite).toBeDefined();
      expect(revocReqProps.motDePasse).toBeDefined();
    });

    it('doit définir GET /av/{nature}/certificats/{numeroSerie}/statut avec ses statuts et champs requis', () => {
      const getStatut = doc.paths['/av/{nature}/certificats/{numeroSerie}/statut'].get;
      expect(Object.keys(getStatut.responses).sort()).toEqual(['200', '400', '404']);

      const statutEnum = doc.components?.schemas?.StatutCertificat?.enum;
      expect(statutEnum).toEqual(['VALIDE', 'SUSPENDU', 'REVOQUE', 'INCONNU']);

      const props = doc.components?.schemas?.StatutCertificatReponse?.properties ?? {};
      for (const field of [
        'numeroSerie',
        'statut',
        'identifiantAcEmettrice',
        'motifInvalidation',
        'dateInvalidation',
        'horodatageVerification',
        'identifiantAv',
      ]) {
        expect(props[field]).toBeDefined();
      }
    });

    it('doit aligner les descriptions sur AMQP 0-9-1 et fournir tous les schémas et exemples requis', () => {
      for (const amqpIdentifier of [
        'ex.pki.commandes',
        'ex.pki.publications',
        'q.pki.ac.<id_ac>.demandes',
        'q.pki.ae.<id_ae>.reponses',
        'q.pki.publication.flux',
        'q.pki.av.<nature>.flux',
      ]) {
        expect(rawOpenApi).toContain(amqpIdentifier);
      }

      const schemas = doc.components?.schemas ?? {};
      for (const schemaName of [
        'UsageCle',
        'StatutCertificat',
        'Certificat',
        'DroitsEntiteAE',
        'DemandeCertificationRequete',
        'DemandeCertificationReponse',
        'DemandeRevocationRequete',
        'DemandeRevocationReponse',
        'StatutCertificatReponse',
        'CheminCertificationReponse',
        'AutoriteCertificationInfo',
        'EntreeLcr',
        'ListeCertificatsRevoques',
        'ErreurApi',
      ]) {
        expect(schemas[schemaName]).toBeDefined();
      }
      expect(schemas.ValidationCertificatRequete).toBeUndefined();
      expect(schemas.ValidationCertificatReponse).toBeUndefined();

      const certPostExamples =
        doc.paths['/ae/{nature}/demandes-certification'].post.requestBody.content['application/json']
          .examples;
      expect(Object.keys(certPostExamples).length).toBeGreaterThanOrEqual(2);
    });

    it('doit résoudre toutes les références internes $ref dans components', () => {
      const refs = [...rawOpenApi.matchAll(/\$ref:\s*['"]#\/components\/([^/'"]+)\/([^/'"]+)['"]/g)];
      expect(refs.length).toBeGreaterThan(0);
      for (const [, section, name] of refs) {
        expect(doc.components?.[section]?.[name], `#/components/${section}/${name}`).toBeDefined();
      }
    });
  });

  describe('Diagrammes PlantUML (docs/diagrams/*.puml)', () => {
    it('doit contenir exactement les 9 fichiers .puml autonomes valides (@startuml / @enduml) sans aucun reliquat hérité', () => {
      expect(existsSync(DIAGRAMS_DIR)).toBe(true);
      const files = readdirSync(DIAGRAMS_DIR).filter((f) => f.endsWith('.puml')).sort();
      expect(files).toEqual([...EXPECTED_DIAGRAMS].sort());

      for (const file of EXPECTED_DIAGRAMS) {
        const content = readFileSync(resolve(DIAGRAMS_DIR, file), 'utf8').trim();
        expect(content.startsWith('@startuml'), `${file} doit commencer par @startuml`).toBe(true);
        expect(content.endsWith('@enduml'), `${file} doit finir par @enduml`).toBe(true);
        expect(FORBIDDEN_LEGACY_PROTOCOL_REGEX.test(content), `${file} ne doit contenir aucun reliquat`).toBe(false);
        expect(FORBIDDEN_LEGACY_DEST_REGEX.test(content), `${file} ne doit contenir aucune destination legacy`).toBe(false);
      }
    });

    it('doit garantir la neutralité technologique stricte des diagrammes 01 à 07', () => {
      for (const file of TECH_NEUTRAL_DIAGRAMS) {
        const content = readFileSync(resolve(DIAGRAMS_DIR, file), 'utf8');
        for (const pattern of TECH_NEUTRAL_FORBIDDEN_PATTERNS) {
          expect(content, `${file} ne doit pas correspondre à ${pattern}`).not.toMatch(pattern);
        }
      }
    });

    it('01-cas-utilisation.puml doit présenter les 4 acteurs et ~7 cas d’utilisation majeurs sans sous-bulles', () => {
      const content = readFileSync(resolve(DIAGRAMS_DIR, '01-cas-utilisation.puml'), 'utf8');
      for (const actor of ['Porteur', 'Utilisateur ICP', 'Correspondant', 'Administrateur PKI']) {
        expect(content).toContain(actor);
      }
      const useCases = content.match(/\busecase\b/gi) ?? [];
      expect(useCases.length).toBeGreaterThanOrEqual(6);
      expect(useCases.length).toBeLessThanOrEqual(8);
    });

    it('02-architecture-blocs.puml doit comporter strictement les 6 grands blocs métier sans sous-instances', () => {
      const content = readFileSync(resolve(DIAGRAMS_DIR, '02-architecture-blocs.puml'), 'utf8');
      const expectedBlocks = [
        'Ressources & Clients',
        "Autorités d'Enregistrement (par nature)",
        'Autorités de Validation (par nature)',
        'Service de Publication',
        "Hiérarchie d'AC (3 niveaux)",
        'Messagerie Sécurisée',
      ];
      for (const block of expectedBlocks) {
        expect(content).toContain(block);
      }
      const blockDefs = content
        .split(/\r?\n/)
        .filter((line) => /^\s*(rectangle|component|package|node|cloud|database)\b/i.test(line));
      expect(blockDefs).toHaveLength(6);
      expect(content).not.toContain('{');
    });

    it('03-hierarchie-ac.puml doit modéliser la hiérarchie d’AC sur 3 niveaux jusqu’aux Porteurs', () => {
      const content = readFileSync(resolve(DIAGRAMS_DIR, '03-hierarchie-ac.puml'), 'utf8');
      expect(content).toContain('AC Racine');
      expect(content).toMatch(/Niveau 1|N1/i);
      expect(content).toMatch(/AC Fille.*Direction|Direction/i);
      expect(content).toMatch(/Niveau 2|N2/i);
      expect(content).toMatch(/AC Fille.*Service|Service/i);
      expect(content).toMatch(/Niveau 3|N3/i);
      expect(content).toContain('Porteurs');
    });

    it('04-sequence-creation-certificat.puml doit compter les 5 participants métier et un bloc alt AE', () => {
      const content = readFileSync(
        resolve(DIAGRAMS_DIR, '04-sequence-creation-certificat.puml'),
        'utf8',
      );
      const participants = content
        .split(/\r?\n/)
        .filter((l) => /^\s*(actor|participant)\b/i.test(l));
      expect(participants).toHaveLength(5);
      for (const p of ['Porteur', 'AE', 'AC', 'Service de Publication', 'AV']) {
        expect(content).toContain(p);
      }
      expect(content).toMatch(/\balt\b/i);
    });

    it('05-sequence-revocation-suspension.puml doit compter les 5 participants métier et la mise à jour LCR', () => {
      const content = readFileSync(
        resolve(DIAGRAMS_DIR, '05-sequence-revocation-suspension.puml'),
        'utf8',
      );
      const participants = content
        .split(/\r?\n/)
        .filter((l) => /^\s*(actor|participant)\b/i.test(l));
      expect(participants).toHaveLength(5);
      for (const p of ['Porteur', 'AE', 'AC', 'Service de Publication', 'AV']) {
        expect(content).toContain(p);
      }
      expect(content).toMatch(/LCR/i);
      expect(content).toMatch(/Révocation/i);
      expect(content).toMatch(/Suspension/i);
    });

    it('06-sequence-validation-4-etapes.puml doit comporter strictement 3 participants et les 4 étapes orchestrées par Utilisateur ICP', () => {
      const content = readFileSync(
        resolve(DIAGRAMS_DIR, '06-sequence-validation-4-etapes.puml'),
        'utf8',
      );
      const participants = content
        .split(/\r?\n/)
        .filter((l) => /^\s*(actor|participant)\b/i.test(l));
      expect(participants).toHaveLength(3);
      for (const p of ['Utilisateur ICP', 'Service de Publication', 'AV']) {
        expect(content).toContain(p);
      }
      expect(content).toMatch(/Étape 1|1\./i);
      expect(content).toMatch(/Étape 2|2\./i);
      expect(content).toMatch(/Étape 3|3\./i);
      expect(content).toMatch(/Étape 4|4\./i);
    });

    it('07-sequence-messagerie-securisee.puml doit comporter les 4 participants métier, le verrouillage du niveau et FIN_MSG', () => {
      const content = readFileSync(
        resolve(DIAGRAMS_DIR, '07-sequence-messagerie-securisee.puml'),
        'utf8',
      );
      const participants = content
        .split(/\r?\n/)
        .filter((l) => /^\s*(actor|participant)\b/i.test(l));
      expect(participants).toHaveLength(4);
      for (const p of ['Correspondant A', 'Service de Publication', 'AV', 'Correspondant B']) {
        expect(content).toContain(p);
      }
      expect(content).toContain('Niveau de sécurité');
      expect(content).toContain('FIN_MSG');
    });

    it('08-architecture-amqp.puml doit représenter les 3 échangeurs durables, leurs bindings/clés et les 5 files durables', () => {
      const content = readFileSync(
        resolve(DIAGRAMS_DIR, '08-architecture-amqp.puml'),
        'utf8',
      );
      expect(content).toContain('ex.pki.commandes');
      expect(content).toContain('ex.pki.publications');
      expect(content).toContain('ex.chat.messages');
      expect(content).toMatch(/direct/i);
      expect(content).toMatch(/topic/i);

      for (const queuePattern of [
        'q.pki.ac.<id_ac>.demandes',
        'q.pki.ae.<id_ae>.reponses',
        'q.pki.publication.flux',
        'q.pki.av.<nature>.flux',
        'q.chat.inbox.<id_correspondant>',
      ]) {
        expect(content).toContain(queuePattern);
      }

      for (const routingKey of [
        'ac.<id_ac>',
        'ae.<id_ae>',
        'certificat.',
        'lcr.',
        'inbox.<id_correspondant>',
      ]) {
        expect(content).toContain(routingKey);
      }
    });

    it('09-microservices-edge.puml doit regrouper les 4 rôles Edge sans nom d’outil vendeur ni protocole hérité/WebSocket/STOMP', () => {
      const content = readFileSync(
        resolve(DIAGRAMS_DIR, '09-microservices-edge.puml'),
        'utf8',
      );
      expect(content).toContain('Ressources');
      expect(content).toContain('Couche Edge');
      for (const role of [
        'API Gateway',
        'Passerelle Edge Messagerie',
        'Service Discovery',
        'Configuration Server',
      ]) {
        expect(content).toContain(role);
      }
      expect(content).toContain('Services ICP');
      expect(content).toContain('Messagerie');
      expect(content).not.toMatch(FORBIDDEN_VENDOR_NAMES_REGEX);
      expect(content).not.toMatch(FORBIDDEN_LEGACY_PROTOCOL_REGEX);
      expect(content).not.toMatch(/\b(websocket|stomp)\b/i);
    });
  });
});
