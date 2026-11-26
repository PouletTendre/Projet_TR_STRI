import { publicKeyPemToBase64, verifyCertificatSignature } from '../crypto/index.js';
import type {
  Certificat,
  CheminCertificationReponse,
  NatureRessource,
  RestTransport,
  StatutCertificat,
  StatutCertificatReponse,
  UsageCle,
  ValidationCertificatRequete,
  ValidationCertificatReponse
} from '../types/index.js';

export interface UtilisateurIcpClientConfig {
  transport: RestTransport;
  certificatAcRacine: Certificat;
  horloge?: () => Date;
}

export interface FiltresRechercheCertificats {
  sujet?: string;
  acEmettriceId?: string;
  usage?: UsageCle;
  uniquementValides?: boolean;
}

interface ResultatEtape {
  valide: boolean;
  erreurs: string[];
}

function estUsageCompatible(usageCertificat: UsageCle, usageAttendu: UsageCle): boolean {
  if (usageCertificat === usageAttendu) {
    return true;
  }
  if (
    usageCertificat === 'SIGNATURE_ET_CHIFFREMENT' &&
    (usageAttendu === 'SIGNATURE' || usageAttendu === 'CHIFFREMENT')
  ) {
    return true;
  }
  return false;
}

function certificatsIdentiques(a: Certificat, b: Certificat): boolean {
  return (
    a.numeroSerie === b.numeroSerie &&
    a.sujet === b.sujet &&
    a.identifiantAcEmettrice === b.identifiantAcEmettrice &&
    publicKeyPemToBase64(a.clePublique) === publicKeyPemToBase64(b.clePublique) &&
    a.signatureAc === b.signatureAc
  );
}

/**
 * Client Utilisateur ICP orchestrant côté client les 4 étapes réglementaires
 * de validation d'un Certificat en consommant le Service de Publication
 * (`/annuaire/...`) et l'Autorité de Validation (`/av/{nature}/...`).
 */
export class UtilisateurIcpClient {
  readonly certificatAcRacine: Certificat;
  private readonly transport: RestTransport;
  private readonly horloge: () => Date;

  constructor(config: UtilisateurIcpClientConfig);
  constructor(
    transport: RestTransport,
    certificatAcRacine: Certificat,
    horloge?: () => Date
  );
  constructor(
    transportOrConfig: RestTransport | UtilisateurIcpClientConfig,
    certificatAcRacine?: Certificat,
    horloge?: () => Date
  ) {
    if (typeof transportOrConfig === 'function') {
      if (!certificatAcRacine) {
        throw new Error('Le certificat de l’AC Racine (ancre de confiance) est obligatoire.');
      }
      this.transport = transportOrConfig;
      this.certificatAcRacine = { ...certificatAcRacine };
      this.horloge = horloge ?? (() => new Date());
    } else {
      this.transport = transportOrConfig.transport;
      this.certificatAcRacine = { ...transportOrConfig.certificatAcRacine };
      this.horloge = transportOrConfig.horloge ?? (() => new Date());
    }
  }

  async recupererCertificat(numeroSerie: string): Promise<Certificat | null> {
    const rep = await this.transport({
      method: 'GET',
      path: `/annuaire/certificats/${encodeURIComponent(numeroSerie)}`
    });
    if (rep.status !== 200 || !rep.body || typeof rep.body !== 'object') {
      return null;
    }
    return rep.body as Certificat;
  }

  async rechercherCertificats(
    filtres: FiltresRechercheCertificats = {}
  ): Promise<Certificat[]> {
    const query: Record<string, string | number | boolean | undefined> = {};
    if (filtres.sujet !== undefined) {
      query.sujet = filtres.sujet;
    }
    if (filtres.acEmettriceId !== undefined) {
      query.acEmettriceId = filtres.acEmettriceId;
    }
    if (filtres.usage !== undefined) {
      query.usage = filtres.usage;
    }
    if (filtres.uniquementValides !== undefined) {
      query.uniquementValides = filtres.uniquementValides;
    }

    const rep = await this.transport({
      method: 'GET',
      path: '/annuaire/certificats',
      query
    });
    if (rep.status !== 200 || !Array.isArray(rep.body)) {
      return [];
    }
    return rep.body as Certificat[];
  }

  async validerCertificat(
    requete: ValidationCertificatRequete
  ): Promise<ValidationCertificatReponse> {
    const maintenant = this.horloge();
    const horodatageValidation = maintenant.toISOString();

    const repChemin = await this.transport({
      method: 'GET',
      path: `/annuaire/certificats/${encodeURIComponent(requete.numeroSerieCertificat)}/chemin-certification`
    });

    const bodyChemin = repChemin.body as Partial<CheminCertificationReponse> | null;
    const chaine =
      repChemin.status === 200 &&
      bodyChemin &&
      Array.isArray(bodyChemin.chaineCertificats)
        ? bodyChemin.chaineCertificats
        : [];

    if (chaine.length === 0) {
      const statutAv = await this.consulterStatutAv(
        requete.natureRessource,
        requete.numeroSerieCertificat
      );
      return {
        valide: false,
        numeroSerieCertificat: requete.numeroSerieCertificat,
        statutCourant: statutAv.statut,
        detailsEtapes: {
          etape1ValiditeTemporelle: false,
          etape2ChaineEtSignatures: false,
          etape3StatutAv: false,
          etape4PolitiqueUsageEtSujet: false,
          messageDiagnostic: `Chemin de certification introuvable pour le certificat "${requete.numeroSerieCertificat}" (HTTP ${repChemin.status}).`
        },
        cheminCertification: [],
        horodatageValidation
      };
    }

    const etape1 = this.verifierEtape1ValiditeTemporelle(chaine, maintenant);
    const etape2 = this.verifierEtape2ChaineEtSignatures(
      chaine,
      requete.numeroSerieCertificat
    );
    const etape3 = await this.verifierEtape3StatutAv(
      chaine,
      requete.natureRessource
    );
    const cible = chaine[0]!;
    const etape4 = this.verifierEtape4Politique(cible, requete);

    const valide =
      etape1.valide && etape2.valide && etape3.valide && etape4.valide;

    const toutesErreurs = [
      ...etape1.erreurs,
      ...etape2.erreurs,
      ...etape3.erreurs,
      ...etape4.erreurs
    ];

    const messageDiagnostic = valide
      ? 'Validation réussie sur les 4 étapes réglementaires.'
      : toutesErreurs.join(' ; ');

    return {
      valide,
      numeroSerieCertificat: requete.numeroSerieCertificat,
      statutCourant: etape3.statutCible,
      detailsEtapes: {
        etape1ValiditeTemporelle: etape1.valide,
        etape2ChaineEtSignatures: etape2.valide,
        etape3StatutAv: etape3.valide,
        etape4PolitiqueUsageEtSujet: etape4.valide,
        messageDiagnostic
      },
      cheminCertification: chaine.map((c) => ({ ...c })),
      horodatageValidation
    };
  }

  private verifierEtape1ValiditeTemporelle(
    chaine: Certificat[],
    maintenant: Date
  ): ResultatEtape {
    const erreurs: string[] = [];
    const nowMs = maintenant.getTime();

    for (const cert of chaine) {
      const debutMs = Date.parse(cert.dateDebutValidite);
      const finMs = Date.parse(cert.dateFinValidite);

      if (Number.isNaN(debutMs) || Number.isNaN(finMs)) {
        erreurs.push(
          `Étape 1 : dates de validité invalides pour le certificat "${cert.numeroSerie}" (${cert.sujet}).`
        );
        continue;
      }

      if (nowMs < debutMs) {
        erreurs.push(
          `Étape 1 : certificat "${cert.numeroSerie}" (${cert.sujet}) pas encore valide (début : ${cert.dateDebutValidite}).`
        );
      } else if (nowMs > finMs) {
        erreurs.push(
          `Étape 1 : certificat "${cert.numeroSerie}" (${cert.sujet}) expiré depuis ${cert.dateFinValidite}.`
        );
      }
    }

    return {
      valide: erreurs.length === 0,
      erreurs
    };
  }

  private verifierEtape2ChaineEtSignatures(
    chaine: Certificat[],
    numeroSerieAttendu: string
  ): ResultatEtape {
    const erreurs: string[] = [];

    if (chaine[0]?.numeroSerie !== numeroSerieAttendu) {
      erreurs.push(
        `Étape 2 : le premier certificat du chemin ("${chaine[0]?.numeroSerie ?? 'aucun'}") ne correspond pas au numéro de série demandé "${numeroSerieAttendu}".`
      );
    }

    if (this.certificatAcRacine.usage !== 'CERTIFICATION_AC') {
      erreurs.push(
        `Étape 2 : l'ancre de confiance "${this.certificatAcRacine.sujet}" ne possède pas l'usage CERTIFICATION_AC.`
      );
    }
    if (
      this.certificatAcRacine.identifiantAcEmettrice !==
      this.certificatAcRacine.sujet
    ) {
      erreurs.push(
        `Étape 2 : l'ancre de confiance "${this.certificatAcRacine.sujet}" n'est pas auto-émise.`
      );
    }
    if (
      !verifyCertificatSignature(
        this.certificatAcRacine,
        this.certificatAcRacine.clePublique
      )
    ) {
      erreurs.push(
        `Étape 2 : signature auto-signée invalide sur l'ancre de confiance "${this.certificatAcRacine.sujet}".`
      );
    }

    const racineChaine = chaine[chaine.length - 1];
    if (!racineChaine || !certificatsIdentiques(racineChaine, this.certificatAcRacine)) {
      erreurs.push(
        `Étape 2 : le chemin de certification ne remonte pas jusqu'à l'AC Racine de confiance "${this.certificatAcRacine.sujet}".`
      );
    }

    for (let i = 0; i < chaine.length - 1; i += 1) {
      const enfant = chaine[i]!;
      const parent = chaine[i + 1]!;

      if (enfant.identifiantAcEmettrice !== parent.sujet) {
        erreurs.push(
          `Étape 2 : rupture de chaîne entre "${enfant.numeroSerie}" (émettrice "${enfant.identifiantAcEmettrice}") et "${parent.sujet}".`
        );
      }

      if (parent.usage !== 'CERTIFICATION_AC') {
        erreurs.push(
          `Étape 2 : l'AC signataire "${parent.sujet}" ("${parent.numeroSerie}") ne possède pas l'usage CERTIFICATION_AC (usage actuel : "${parent.usage}").`
        );
      }

      if (!verifyCertificatSignature(enfant, parent.clePublique)) {
        erreurs.push(
          `Étape 2 : signature cryptographique invalide sur le certificat "${enfant.numeroSerie}" (${enfant.sujet}) attribué à "${parent.sujet}".`
        );
      }
    }

    return {
      valide: erreurs.length === 0,
      erreurs
    };
  }

  private async consulterStatutAv(
    natureRessource: NatureRessource,
    numeroSerie: string
  ): Promise<{ ok: boolean; statut: StatutCertificat; messageErreur?: string }> {
    const rep = await this.transport({
      method: 'GET',
      path: `/av/${encodeURIComponent(natureRessource)}/certificats/${encodeURIComponent(numeroSerie)}/statut`
    });

    if (rep.status !== 200 || !rep.body || typeof rep.body !== 'object') {
      return {
        ok: false,
        statut: 'INCONNU',
        messageErreur: `HTTP ${rep.status}`
      };
    }

    const body = rep.body as Partial<StatutCertificatReponse>;
    const statut: StatutCertificat =
      body.statut === 'VALIDE' ||
      body.statut === 'SUSPENDU' ||
      body.statut === 'REVOQUE' ||
      body.statut === 'INCONNU'
        ? body.statut
        : 'INCONNU';

    return { ok: true, statut };
  }

  private async verifierEtape3StatutAv(
    chaine: Certificat[],
    natureRessource: NatureRessource
  ): Promise<ResultatEtape & { statutCible: StatutCertificat }> {
    const erreurs: string[] = [];
    let statutCible: StatutCertificat = 'INCONNU';

    for (let i = 0; i < chaine.length; i += 1) {
      const cert = chaine[i]!;
      const estAncreRacine =
        i > 0 &&
        cert.numeroSerie === this.certificatAcRacine.numeroSerie &&
        cert.identifiantAcEmettrice === cert.sujet;

      if (estAncreRacine) {
        continue;
      }

      const res = await this.consulterStatutAv(natureRessource, cert.numeroSerie);
      if (i === 0) {
        statutCible = res.statut;
      }

      if (!res.ok) {
        erreurs.push(
          `Étape 3 : erreur lors de la consultation de l'AV pour "${cert.numeroSerie}" (${cert.sujet}) : ${res.messageErreur}.`
        );
      } else if (res.statut !== 'VALIDE') {
        erreurs.push(
          `Étape 3 : statut "${res.statut}" retourné par l'AV pour le certificat "${cert.numeroSerie}" (${cert.sujet}).`
        );
      }
    }

    return {
      valide: erreurs.length === 0,
      erreurs,
      statutCible
    };
  }

  private verifierEtape4Politique(
    cible: Certificat,
    requete: ValidationCertificatRequete
  ): ResultatEtape {
    const erreurs: string[] = [];

    if (!estUsageCompatible(cible.usage, requete.usageAttendu)) {
      erreurs.push(
        `Étape 4 : usage du certificat "${cible.usage}" incompatible avec l'usage attendu "${requete.usageAttendu}".`
      );
    }

    if (
      requete.sujetAttendu !== undefined &&
      cible.sujet !== requete.sujetAttendu
    ) {
      erreurs.push(
        `Étape 4 : sujet du certificat "${cible.sujet}" différent du sujet attendu "${requete.sujetAttendu}".`
      );
    }

    return {
      valide: erreurs.length === 0,
      erreurs
    };
  }
}
