import type { AutoriteCertification, HierarchieAcResult } from '../ac/index.js';
import type {
  Certificat,
  AutoriteCertificationInfo,
  RestRequest,
  RestResponse,
  ErreurApi,
} from '../types/index.js';
import type {
  CaTopologyNode,
  ConfigurationServerOptions,
} from './types.js';

export class ConfigurationServer {
  private rootCaAnchor?: Certificat;
  private topology = new Map<string, CaTopologyNode>();
  private natures = new Set<string>();

  constructor(options?: ConfigurationServerOptions) {
    if (options?.rootCa) {
      this.setRootCaAnchor(this.extractCertificate(options.rootCa));
    }

    if (options?.initialTopology) {
      for (const node of options.initialTopology) {
        this.topology.set(node.acId, { ...node });
      }
    }

    if (options?.initialNatures) {
      for (const nature of options.initialNatures) {
        this.natures.add(nature);
      }
    } else {
      // Standard baseline natures
      this.natures.add('messagerie');
      this.natures.add('routeurs');
      this.natures.add('services');
      this.natures.add('utilisateurs');
    }
  }

  private extractCertificate(
    caOrCert: AutoriteCertification | Certificat | AutoriteCertificationInfo
  ): Certificat {
    if ('certificat' in caOrCert && caOrCert.certificat) {
      return caOrCert.certificat;
    }
    if ('certificatAc' in caOrCert && caOrCert.certificatAc) {
      return caOrCert.certificatAc;
    }
    return caOrCert as Certificat;
  }

  public setRootCaAnchor(cert: Certificat): void {
    this.rootCaAnchor = cert;
    if (!this.topology.has(cert.sujet)) {
      this.topology.set(cert.sujet, {
        acId: cert.sujet,
        nomOrganisationnel: cert.sujet,
        niveau: 1,
        acParenteId: null,
        certificatAc: cert,
        jmsQueueDemandes: `queue.pki.ac.${cert.sujet}.demandes`,
        dureeValiditeAnnees: 10,
      });
    }
  }

  public getRootCaAnchor(): Certificat | undefined {
    return this.rootCaAnchor;
  }

  public registerCa(
    ca: AutoriteCertification | AutoriteCertificationInfo | CaTopologyNode
  ): CaTopologyNode {
    let node: CaTopologyNode;

    if ('jmsQueueDemandes' in ca) {
      node = { ...ca };
    } else if ('getInfo' in ca && typeof ca.getInfo === 'function') {
      const info = ca.getInfo();
      node = {
        acId: info.acId,
        nomOrganisationnel: info.nomOrganisationnel,
        niveau: info.niveau,
        acParenteId: info.acParenteId,
        certificatAc: info.certificatAc,
        jmsQueueDemandes: `queue.pki.ac.${info.acId}.demandes`,
      };
    } else {
      const info = ca as AutoriteCertificationInfo;
      node = {
        acId: info.acId,
        nomOrganisationnel: info.nomOrganisationnel,
        niveau: info.niveau,
        acParenteId: info.acParenteId,
        certificatAc: info.certificatAc,
        jmsQueueDemandes: `queue.pki.ac.${info.acId}.demandes`,
      };
    }

    if (node.niveau === 1 && node.certificatAc) {
      this.rootCaAnchor = node.certificatAc;
    }

    this.topology.set(node.acId, node);
    return node;
  }

  public registerSubordinateCa(
    parentAcId: string,
    caInfo: {
      id: string;
      nomOrganisationnel: string;
      certificatAc?: Certificat;
      dureeValiditeAnnees?: number;
    }
  ): CaTopologyNode {
    const parent = this.topology.get(parentAcId);
    const parentNiveau = parent ? parent.niveau : 1;
    const childNiveau = parentNiveau + 1;

    const node: CaTopologyNode = {
      acId: caInfo.id,
      nomOrganisationnel: caInfo.nomOrganisationnel,
      niveau: childNiveau,
      acParenteId: parentAcId,
      certificatAc: caInfo.certificatAc,
      jmsQueueDemandes: `queue.pki.ac.${caInfo.id}.demandes`,
      dureeValiditeAnnees: caInfo.dureeValiditeAnnees ?? (childNiveau === 2 ? 5 : 2),
    };

    this.topology.set(caInfo.id, node);
    return node;
  }

  public getCaTopology(): CaTopologyNode[] {
    return Array.from(this.topology.values()).sort((a, b) => a.niveau - b.niveau);
  }

  public getCa(acId: string): CaTopologyNode | undefined {
    return this.topology.get(acId);
  }

  public registerNature(nature: string): void {
    this.natures.add(nature.toLowerCase());
  }

  public getNatures(): string[] {
    return Array.from(this.natures);
  }

  public hasNature(nature: string): boolean {
    return this.natures.has(nature.toLowerCase());
  }

  public loadFromHierarchy(hierarchy: HierarchieAcResult): void {
    this.registerCa(hierarchy.acRacine);
    for (const ac2 of hierarchy.acsNiveau2) {
      this.registerCa(ac2);
    }
    for (const ac3 of hierarchy.acsNiveau3) {
      this.registerCa(ac3);
    }
  }

  public handleRequest(req: RestRequest): RestResponse {
    const cleanPath = req.path.split('?')[0].replace(/\/+$/, '');

    // 1. GET /config/racine
    if (req.method === 'GET' && cleanPath === '/config/racine') {
      const root = this.getRootCaAnchor();
      if (!root) {
        const err: ErreurApi = {
          code: 'RACINE_NON_CONFIGUREE',
          message: "L'ancre racine de confiance n'est pas encore configurée.",
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: root,
      };
    }

    // 2. GET /config/topologie
    if (req.method === 'GET' && cleanPath === '/config/topologie') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: this.getCaTopology(),
      };
    }

    // 3. GET /config/topologie/{acId}
    const acMatch = cleanPath.match(/^\/config\/topologie\/([^/]+)$/);
    if (req.method === 'GET' && acMatch) {
      const acId = decodeURIComponent(acMatch[1]);
      const node = this.getCa(acId);
      if (!node) {
        const err: ErreurApi = {
          code: 'AC_INTROUVABLE',
          message: `L'autorité de certification '${acId}' est introuvable dans la topologie.`,
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 404,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: node,
      };
    }

    // 4. GET /config/natures
    if (req.method === 'GET' && cleanPath === '/config/natures') {
      return {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
        body: this.getNatures(),
      };
    }

    // 5. POST /config/natures
    if (req.method === 'POST' && cleanPath === '/config/natures') {
      const body = req.body as { nature?: string } | undefined;
      if (!body?.nature) {
        const err: ErreurApi = {
          code: 'REQUETE_INVALIDE',
          message: "Le champ 'nature' est obligatoire.",
          horodatage: new Date().toISOString(),
          chemin: req.path,
        };
        return {
          status: 400,
          headers: { 'Content-Type': 'application/json' },
          body: err,
        };
      }
      this.registerNature(body.nature);
      return {
        status: 201,
        headers: { 'Content-Type': 'application/json' },
        body: { nature: body.nature.toLowerCase(), statut: 'ENREGISTREE' },
      };
    }

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
}
