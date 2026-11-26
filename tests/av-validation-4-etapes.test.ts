import { describe, it, expect } from 'vitest';
import {
  AMQP_EXCHANGES,
  AutoriteCertification,
  AutoriteEnregistrement,
  AutoriteValidation,
  InMemoryAmqpBroker,
  ServicePublication,
  UtilisateurIcpClient,
  amorcerHierarchieAc,
  generateRsaKeyPair,
  signCertificat
} from '../src/index.js';
import type {
  Certificat,
  CheminCertificationReponse,
  DemandeCertificationReponse,
  ErreurApi,
  RestRequest,
  RestResponse,
  StatutCertificatReponse,
  ValidationCertificatReponse
} from '../src/index.js';

describe('Slice 1 — Autorité de Validation (AV) spécialisée par nature, bindings AMQP et façade REST stricte', () => {
  it('déclare q.pki.av.<nature>.flux avec exactement 3 bindings, isole les natures, suit les LCR en temps réel et rejette /validations en 404', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const avMessagerie = new AutoriteValidation({
      nature: 'messagerie',
      broker
    });
    await avMessagerie.ready();

    const avRouteurs = new AutoriteValidation({
      nature: 'routeurs',
      broker
    });
    await avRouteurs.ready();

    // Vérification stricte de la file durable et des 3 bindings par AV sur ex.pki.publications
    const queues = broker.listQueues();
    const queueMsg = queues.find((q) => q.name === 'q.pki.av.messagerie.flux');
    const queueRtr = queues.find((q) => q.name === 'q.pki.av.routeurs.flux');
    expect(queueMsg?.durable).toBe(true);
    expect(queueRtr?.durable).toBe(true);

    const bindingsMsg = broker
      .listBindings()
      .filter((b) => b.queue === 'q.pki.av.messagerie.flux');
    expect(bindingsMsg).toHaveLength(3);
    expect(bindingsMsg.map((b) => `${b.exchange}:${b.routingKey}`).sort()).toEqual([
      `${AMQP_EXCHANGES.PUBLICATIONS}:certificat.*.ac`,
      `${AMQP_EXCHANGES.PUBLICATIONS}:certificat.*.messagerie`,
      `${AMQP_EXCHANGES.PUBLICATIONS}:lcr.#`
    ]);

    const bindingsRtr = broker
      .listBindings()
      .filter((b) => b.queue === 'q.pki.av.routeurs.flux');
    expect(bindingsRtr).toHaveLength(3);
    expect(bindingsRtr.map((b) => `${b.exchange}:${b.routingKey}`).sort()).toEqual([
      `${AMQP_EXCHANGES.PUBLICATIONS}:certificat.*.ac`,
      `${AMQP_EXCHANGES.PUBLICATIONS}:certificat.*.routeurs`,
      `${AMQP_EXCHANGES.PUBLICATIONS}:lcr.#`
    ]);

    const hierarchie = await amorcerHierarchieAc(broker);

    const aeMsg = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await aeMsg.ready();

    const aeRtr = new AutoriteEnregistrement({
      nature: 'routeurs',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'routeur-core-01.infra.organisation.fr',
          motDePasse: 'RouterAuth#99',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-INFRA-RESEAU'
        }
      ]
    });
    await aeRtr.ready();

    // Enrôlement d'Alice (messagerie) et d'un routeur (routeurs)
    const aliceKeys = generateRsaKeyPair();
    const repAlice = await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: aliceKeys.publicKeyBase64
      }
    });
    expect(repAlice.status).toBe(201);
    const certAlice = (repAlice.body as DemandeCertificationReponse).certificat!;

    const rtrKeys = generateRsaKeyPair();
    const repRtr = await aeRtr.handleRestRequest({
      method: 'POST',
      path: '/ae/routeurs/demandes-certification',
      body: {
        nomEntite: 'routeur-core-01.infra.organisation.fr',
        motDePasse: 'RouterAuth#99',
        usage: 'SIGNATURE',
        clePublique: rtrKeys.publicKeyBase64
      }
    });
    expect(repRtr.status).toBe(201);
    const certRtr = (repRtr.body as DemandeCertificationReponse).certificat!;

    // AV-Messagerie connaît Alice et toutes les AC (N1, N2, N3), mais PAS le routeur (INCONNU)
    const statutAliceSurMsg = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/api/v1/av/messagerie/certificats/${certAlice.numeroSerie}/statut`
    });
    expect(statutAliceSurMsg.status).toBe(200);
    expect(statutAliceSurMsg.body).toMatchObject({
      numeroSerie: certAlice.numeroSerie,
      statut: 'VALIDE',
      identifiantAcEmettrice: 'AC-N3-DSI-MESSAGERIE',
      motifInvalidation: null,
      dateInvalidation: null,
      identifiantAv: 'av-messagerie'
    } satisfies Partial<StatutCertificatReponse>);
    expect(typeof (statutAliceSurMsg.body as StatutCertificatReponse).horodatageVerification).toBe('string');

    const statutAcN3SurMsg = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/av/messagerie/certificats/${hierarchie.services.dsiMessagerie.getCertificatAc().numeroSerie}/statut`
    });
    expect(statutAcN3SurMsg.status).toBe(200);
    expect((statutAcN3SurMsg.body as StatutCertificatReponse).statut).toBe('VALIDE');

    const statutAcN1SurMsg = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/av/messagerie/certificats/${hierarchie.racine.getCertificatAc().numeroSerie}/statut`
    });
    expect(statutAcN1SurMsg.status).toBe(200);
    expect((statutAcN1SurMsg.body as StatutCertificatReponse).statut).toBe('VALIDE');

    const statutRtrSurMsg = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/av/messagerie/certificats/${certRtr.numeroSerie}/statut`
    });
    expect(statutRtrSurMsg.status).toBe(200);
    expect(statutRtrSurMsg.body).toMatchObject({
      numeroSerie: certRtr.numeroSerie,
      statut: 'INCONNU',
      identifiantAcEmettrice: null,
      motifInvalidation: null,
      dateInvalidation: null,
      identifiantAv: 'av-messagerie'
    });

    // AV-Routeurs connaît le routeur, mais PAS Alice (INCONNU)
    const statutRtrSurRtr = avRouteurs.handleRestRequest({
      method: 'GET',
      path: `/av/routeurs/certificats/${certRtr.numeroSerie}/statut`
    });
    expect(statutRtrSurRtr.status).toBe(200);
    expect((statutRtrSurRtr.body as StatutCertificatReponse).statut).toBe('VALIDE');

    const statutAliceSurRtr = avRouteurs.handleRestRequest({
      method: 'GET',
      path: `/av/routeurs/certificats/${certAlice.numeroSerie}/statut`
    });
    expect(statutAliceSurRtr.status).toBe(200);
    expect((statutAliceSurRtr.body as StatutCertificatReponse).statut).toBe('INCONNU');

    // Mises à jour LCR en temps réel : Suspension -> Réactivation -> Révocation
    await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'SUSPENSION',
        motif: 'SUSPENSION_TEMPORAIRE'
      }
    });

    const apresSusp = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/av/messagerie/certificats/${certAlice.numeroSerie}/statut`
    });
    expect(apresSusp.status).toBe(200);
    expect(apresSusp.body).toMatchObject({
      numeroSerie: certAlice.numeroSerie,
      statut: 'SUSPENDU',
      identifiantAcEmettrice: 'AC-N3-DSI-MESSAGERIE',
      motifInvalidation: 'SUSPENSION_TEMPORAIRE'
    });
    expect((apresSusp.body as StatutCertificatReponse).dateInvalidation).not.toBeNull();

    // Même après publication LCR (lcr.#), AV-Routeurs retourne toujours INCONNU pour Alice
    const aliceSurRtrApresLcr = avRouteurs.handleRestRequest({
      method: 'GET',
      path: `/av/routeurs/certificats/${certAlice.numeroSerie}/statut`
    });
    expect((aliceSurRtrApresLcr.body as StatutCertificatReponse).statut).toBe('INCONNU');

    await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REACTIVATION',
        motif: 'FIN_SUSPENSION'
      }
    });
    const apresReact = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/av/messagerie/certificats/${certAlice.numeroSerie}/statut`
    });
    expect(apresReact.body).toMatchObject({
      statut: 'VALIDE',
      motifInvalidation: null,
      dateInvalidation: null
    });

    await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION',
        motif: 'COMPROMISSION_CLE_PRIVEE'
      }
    });
    const apresRevoc = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/av/messagerie/certificats/${certAlice.numeroSerie}/statut`
    });
    expect(apresRevoc.body).toMatchObject({
      statut: 'REVOQUE',
      motifInvalidation: 'COMPROMISSION_CLE_PRIVEE'
    });

    // Numéro de série inconnu -> 200 OK avec statut INCONNU
    const inconnu = avMessagerie.handleRestRequest({
      method: 'GET',
      path: '/av/messagerie/certificats/SN-INCONNU-999/statut'
    });
    expect(inconnu.status).toBe(200);
    expect((inconnu.body as StatutCertificatReponse).statut).toBe('INCONNU');

    // Façade REST stricte : /av/{nature}/validations doit retourner 404
    const getValidations = avMessagerie.handleRestRequest({
      method: 'GET',
      path: '/av/messagerie/validations'
    });
    expect(getValidations.status).toBe(404);
    expect((getValidations.body as ErreurApi).code).toBe('ROUTE_INTROUVABLE');

    const postValidations = avMessagerie.handleRestRequest({
      method: 'POST',
      path: '/api/v1/av/messagerie/validations',
      body: { numeroSerieCertificat: certAlice.numeroSerie }
    });
    expect(postValidations.status).toBe(404);
    expect((postValidations.body as ErreurApi).code).toBe('ROUTE_INTROUVABLE');

    // Mauvaise nature sur cette instance AV -> 404
    const mauvaiseNature = avMessagerie.handleRestRequest({
      method: 'GET',
      path: `/av/routeurs/certificats/${certRtr.numeroSerie}/statut`
    });
    expect(mauvaiseNature.status).toBe(404);

    // Nature invalide -> 400
    const natureInvalide = avMessagerie.handleRestRequest({
      method: 'GET',
      path: '/av/nature-inexistante/certificats/SN-1/statut'
    });
    expect(natureInvalide.status).toBe(400);
  });
});

function creerTransportPki(
  annuaire: ServicePublication,
  avs: Map<string, AutoriteValidation>
) {
  return async (req: RestRequest): Promise<RestResponse> => {
    const [pathOnly] = req.path.split('?', 2);
    const normalized = pathOnly?.startsWith('/api/v1')
      ? pathOnly.slice('/api/v1'.length)
      : (pathOnly ?? '/');

    if (normalized.startsWith('/annuaire/')) {
      return annuaire.handleRestRequest(req);
    }

    const avMatch = /^\/av\/([^/]+)\//.exec(normalized);
    if (avMatch && avMatch[1]) {
      const av = avs.get(decodeURIComponent(avMatch[1]));
      if (av) {
        return av.handleRestRequest(req);
      }
    }

    return {
      status: 404,
      body: {
        code: 'ROUTE_INTROUVABLE',
        message: `Aucun service PKI pour "${req.path}".`,
        horodatage: new Date().toISOString(),
        chemin: req.path
      }
    };
  };
}

describe('Slice 2 — UtilisateurIcpClient : validation nominale en 4 étapes sur chemin 3 niveaux', () => {
  it('valide un Certificat légitime sur 3 niveaux (Porteur -> N3 -> N2 -> Racine) et retourne le diagnostic complet des 4 étapes', async () => {
    const maintenant = new Date('2026-06-01T12:00:00Z');
    const horloge = () => maintenant;

    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker, { horloge });
    await annuaire.ready();

    const avMessagerie = new AutoriteValidation({
      nature: 'messagerie',
      broker,
      horloge
    });
    await avMessagerie.ready();

    const hierarchie = await amorcerHierarchieAc(broker, { horloge });
    const aeMsg = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await aeMsg.ready();

    const aliceKeys = generateRsaKeyPair();
    const repEnrol = await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: aliceKeys.publicKeyBase64
      }
    });
    expect(repEnrol.status).toBe(201);
    const certAlice = (repEnrol.body as DemandeCertificationReponse).certificat!;

    const transport = creerTransportPki(
      annuaire,
      new Map([['messagerie', avMessagerie]])
    );
    const client = new UtilisateurIcpClient(
      transport,
      hierarchie.racine.getCertificatAc(),
      horloge
    );

    const validation: ValidationCertificatReponse = await client.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE',
      sujetAttendu: 'alice.martin@dsi.organisation.fr'
    });

    expect(validation.valide).toBe(true);
    expect(validation.numeroSerieCertificat).toBe(certAlice.numeroSerie);
    expect(validation.statutCourant).toBe('VALIDE');
    expect(validation.detailsEtapes).toEqual({
      etape1ValiditeTemporelle: true,
      etape2ChaineEtSignatures: true,
      etape3StatutAv: true,
      etape4PolitiqueUsageEtSujet: true,
      messageDiagnostic: expect.any(String)
    });
    expect(validation.cheminCertification).toHaveLength(4);
    expect(validation.cheminCertification.map((c) => c.sujet)).toEqual([
      'alice.martin@dsi.organisation.fr',
      'AC-N3-DSI-MESSAGERIE',
      'AC-N2-DSI',
      'AC-N1-RACINE'
    ]);
    expect(validation.horodatageValidation).toBe('2026-06-01T12:00:00.000Z');

    // Helpers de consultation utilisables par les Correspondants (#15)
    const certsAlice = await client.rechercherCertificats({
      sujet: 'alice.martin@dsi.organisation.fr'
    });
    expect(certsAlice).toHaveLength(1);
    expect(certsAlice[0]?.numeroSerie).toBe(certAlice.numeroSerie);

    const certDirect = await client.recupererCertificat(certAlice.numeroSerie);
    expect(certDirect?.numeroSerie).toBe(certAlice.numeroSerie);
  });
});

describe('Slice 3 — Échecs à l’Étape 1 (période de validité du Certificat cible ou d’une AC)', () => {
  it('rejette en Étape 1 un Certificat expiré, pas encore valide, ou émis par une AC Fille expirée', async () => {
    const tEmission = new Date('2026-01-01T00:00:00Z');
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker, { horloge: () => tEmission });
    await annuaire.ready();

    const avMessagerie = new AutoriteValidation({
      nature: 'messagerie',
      broker,
      horloge: () => tEmission
    });
    await avMessagerie.ready();

    const hierarchie = await amorcerHierarchieAc(broker, { horloge: () => tEmission });

    // AC Fille de niveau 3 à validité courte (30 jours) pour tester l'expiration d'une AC
    const acCourte = new AutoriteCertification({
      acId: 'AC-N3-DSI-COURTE',
      nomOrganisationnel: 'Service Messagerie Temporaire',
      niveau: 3,
      acParenteId: 'AC-N2-DSI',
      broker,
      generateurNumeroSerie: hierarchie.generateurNumeroSerie,
      horloge: () => new Date('2026-01-15T00:00:00Z')
    });
    await hierarchie.directions.dsi.certifierAcFille(acCourte, {
      dateDebut: tEmission,
      dureeValiditeJours: 30
    });
    await acCourte.publierLcr();
    await acCourte.reprendreConsommation();

    const aeMsg = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'charlie.temp@dsi.organisation.fr',
          motDePasse: 'Charlie#2026',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-COURTE'
        }
      ]
    });
    await aeMsg.ready();

    const repAlice = await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: generateRsaKeyPair().publicKeyBase64
      }
    });
    const certAlice = (repAlice.body as DemandeCertificationReponse).certificat!;

    const repCharlie = await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'charlie.temp@dsi.organisation.fr',
        motDePasse: 'Charlie#2026',
        usage: 'SIGNATURE',
        clePublique: generateRsaKeyPair().publicKeyBase64
      }
    });
    const certCharlie = (repCharlie.body as DemandeCertificationReponse).certificat!;

    const transport = creerTransportPki(
      annuaire,
      new Map([['messagerie', avMessagerie]])
    );

    // 1. Certificat cible expiré (vérifié en 2027-06-01, fin de validité 2027-01-01)
    const clientApresExpiration = new UtilisateurIcpClient(
      transport,
      hierarchie.racine.getCertificatAc(),
      () => new Date('2027-06-01T00:00:00Z')
    );
    const resExpire = await clientApresExpiration.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resExpire.valide).toBe(false);
    expect(resExpire.detailsEtapes.etape1ValiditeTemporelle).toBe(false);
    expect(resExpire.detailsEtapes.etape2ChaineEtSignatures).toBe(true);
    expect(resExpire.detailsEtapes.etape3StatutAv).toBe(true);
    expect(resExpire.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(true);
    expect(resExpire.detailsEtapes.messageDiagnostic).toMatch(/expir/i);

    // 2. Certificat pas encore valide (vérifié en 2025-12-01)
    const clientAvantValidite = new UtilisateurIcpClient(
      transport,
      hierarchie.racine.getCertificatAc(),
      () => new Date('2025-12-01T00:00:00Z')
    );
    const resPasEncoreValide = await clientAvantValidite.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resPasEncoreValide.valide).toBe(false);
    expect(resPasEncoreValide.detailsEtapes.etape1ValiditeTemporelle).toBe(false);
    expect(resPasEncoreValide.detailsEtapes.messageDiagnostic).toMatch(/pas encore valide/i);

    // 3. AC Fille N3 expirée (vérifié en 2026-03-01 : AC-N3-DSI-COURTE expirée depuis le 2026-01-31, certCharlie encore valide)
    const clientAcExpiree = new UtilisateurIcpClient(
      transport,
      hierarchie.racine.getCertificatAc(),
      () => new Date('2026-03-01T00:00:00Z')
    );
    const resAcExpiree = await clientAcExpiree.validerCertificat({
      numeroSerieCertificat: certCharlie.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resAcExpiree.valide).toBe(false);
    expect(resAcExpiree.detailsEtapes.etape1ValiditeTemporelle).toBe(false);
    expect(resAcExpiree.detailsEtapes.etape2ChaineEtSignatures).toBe(true);
    expect(resAcExpiree.detailsEtapes.etape3StatutAv).toBe(true);
    expect(resAcExpiree.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(true);
    expect(resAcExpiree.detailsEtapes.messageDiagnostic).toContain('AC-N3-DSI-COURTE');
  });
});

describe('Slice 4 — Échecs à l’Étape 2 (signatures, ancre de confiance, rupture de chaîne et usage CERTIFICATION_AC)', () => {
  it('rejette en Étape 2 une signature altérée, une AC Racine non fiable, une chaîne brisée ou une AC intermédiaire sans CERTIFICATION_AC', async () => {
    const maintenant = new Date('2026-06-01T12:00:00Z');
    const horloge = () => maintenant;

    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker, { horloge });
    await annuaire.ready();

    const avMessagerie = new AutoriteValidation({
      nature: 'messagerie',
      broker,
      horloge
    });
    await avMessagerie.ready();

    const hierarchie = await amorcerHierarchieAc(broker, { horloge });
    const aeMsg = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await aeMsg.ready();

    const repAlice = await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: generateRsaKeyPair().publicKeyBase64
      }
    });
    const certAlice = (repAlice.body as DemandeCertificationReponse).certificat!;
    const transportNominal = creerTransportPki(
      annuaire,
      new Map([['messagerie', avMessagerie]])
    );

    // 1. AC Racine non fiable (autre ancre de confiance auto-signée)
    const fausseRacineKey = generateRsaKeyPair();
    const fausseRacineCert = signCertificat(
      {
        numeroSerie: 'SN-2026-FAUSSE-RACINE-000001',
        identifiantAcEmettrice: 'AC-FAUSSE-RACINE',
        niveauAcEmettrice: 1,
        dateDebutValidite: '2026-01-01T00:00:00Z',
        dateFinValidite: '2036-01-01T00:00:00Z',
        usage: 'CERTIFICATION_AC',
        sujet: 'AC-FAUSSE-RACINE',
        natureRessource: 'autorite_certification',
        clePublique: fausseRacineKey.publicKeyBase64,
        algorithmeSignature: 'SHA256withRSA'
      },
      fausseRacineKey.privateKeyPem
    );
    const clientFausseAncre = new UtilisateurIcpClient(
      transportNominal,
      fausseRacineCert,
      horloge
    );
    const resFausseAncre = await clientFausseAncre.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resFausseAncre.valide).toBe(false);
    expect(resFausseAncre.detailsEtapes.etape1ValiditeTemporelle).toBe(true);
    expect(resFausseAncre.detailsEtapes.etape2ChaineEtSignatures).toBe(false);
    expect(resFausseAncre.detailsEtapes.etape3StatutAv).toBe(true);
    expect(resFausseAncre.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(true);

    // 2. Signature altérée sur l'ancre de confiance elle-même
    const racineCorrompue: Certificat = {
      ...hierarchie.racine.getCertificatAc(),
      signatureAc: 'AAAA' + hierarchie.racine.getCertificatAc().signatureAc.slice(4)
    };
    const clientAncreCorrompue = new UtilisateurIcpClient(
      transportNominal,
      racineCorrompue,
      horloge
    );
    const resAncreCorrompue = await clientAncreCorrompue.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resAncreCorrompue.valide).toBe(false);
    expect(resAncreCorrompue.detailsEtapes.etape2ChaineEtSignatures).toBe(false);

    // 3. Signature altérée sur le Certificat cible (modifié en transit sur le transport REST)
    const transportSignatureAlt = async (req: RestRequest): Promise<RestResponse> => {
      const rep = await transportNominal(req);
      if (req.path.endsWith('/chemin-certification') && rep.status === 200) {
        const body = rep.body as CheminCertificationReponse;
        return {
          status: 200,
          body: {
            ...body,
            chaineCertificats: body.chaineCertificats.map((c, idx) =>
              idx === 0 ? { ...c, clePublique: generateRsaKeyPair().publicKeyBase64 } : c
            )
          }
        };
      }
      return rep;
    };
    const clientSigAlt = new UtilisateurIcpClient(
      transportSignatureAlt,
      hierarchie.racine.getCertificatAc(),
      horloge
    );
    const resSigAlt = await clientSigAlt.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resSigAlt.valide).toBe(false);
    expect(resSigAlt.detailsEtapes.etape1ValiditeTemporelle).toBe(true);
    expect(resSigAlt.detailsEtapes.etape2ChaineEtSignatures).toBe(false);
    expect(resSigAlt.detailsEtapes.etape3StatutAv).toBe(true);
    expect(resSigAlt.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(true);

    // 4. Chaîne brisée (certificat intermédiaire manquant)
    const transportChaineBrisee = async (req: RestRequest): Promise<RestResponse> => {
      const rep = await transportNominal(req);
      if (req.path.endsWith('/chemin-certification') && rep.status === 200) {
        const body = rep.body as CheminCertificationReponse;
        return {
          status: 200,
          body: {
            ...body,
            chaineCertificats: [body.chaineCertificats[0]!, body.chaineCertificats[3]!]
          }
        };
      }
      return rep;
    };
    const clientChaineBrisee = new UtilisateurIcpClient(
      transportChaineBrisee,
      hierarchie.racine.getCertificatAc(),
      horloge
    );
    const resChaineBrisee = await clientChaineBrisee.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resChaineBrisee.valide).toBe(false);
    expect(resChaineBrisee.detailsEtapes.etape2ChaineEtSignatures).toBe(false);

    // 5. AC intermédiaire sans usage CERTIFICATION_AC (même avec chaîne signée cohérente)
    const fakeN3Keys = generateRsaKeyPair();
    const certFakeN3SansAcUsage = signCertificat(
      {
        numeroSerie: 'SN-2026-FAKE-N3-NO-AC',
        identifiantAcEmettrice: 'AC-FAUSSE-RACINE',
        niveauAcEmettrice: 1,
        dateDebutValidite: '2026-01-01T00:00:00Z',
        dateFinValidite: '2030-01-01T00:00:00Z',
        usage: 'SIGNATURE',
        sujet: 'AC-N3-SANS-DROIT-AC',
        natureRessource: 'messagerie',
        clePublique: fakeN3Keys.publicKeyBase64,
        algorithmeSignature: 'SHA256withRSA'
      },
      fausseRacineKey.privateKeyPem
    );
    const certPorteurSousFakeN3 = signCertificat(
      {
        numeroSerie: 'SN-2026-PORTEUR-FAKE-N3',
        identifiantAcEmettrice: 'AC-N3-SANS-DROIT-AC',
        niveauAcEmettrice: 3,
        dateDebutValidite: '2026-01-01T00:00:00Z',
        dateFinValidite: '2027-01-01T00:00:00Z',
        usage: 'SIGNATURE',
        sujet: 'eve@dsi.organisation.fr',
        natureRessource: 'messagerie',
        clePublique: generateRsaKeyPair().publicKeyBase64,
        algorithmeSignature: 'SHA256withRSA'
      },
      fakeN3Keys.privateKeyPem
    );
    const transportSansAcUsage = async (req: RestRequest): Promise<RestResponse> => {
      if (req.path.endsWith('/chemin-certification')) {
        return {
          status: 200,
          body: {
            numeroSerieCible: certPorteurSousFakeN3.numeroSerie,
            profondeurHierarchie: 2,
            chaineCertificats: [certPorteurSousFakeN3, certFakeN3SansAcUsage, fausseRacineCert]
          }
        };
      }
      return {
        status: 200,
        body: {
          numeroSerie: req.path.split('/')[4] ?? '',
          statut: 'VALIDE',
          identifiantAcEmettrice: 'AC-FAUSSE-RACINE',
          motifInvalidation: null,
          dateInvalidation: null,
          horodatageVerification: maintenant.toISOString(),
          identifiantAv: 'av-messagerie'
        } satisfies StatutCertificatReponse
      };
    };
    const clientSansAcUsage = new UtilisateurIcpClient(
      transportSansAcUsage,
      fausseRacineCert,
      horloge
    );
    const resSansAcUsage = await clientSansAcUsage.validerCertificat({
      numeroSerieCertificat: certPorteurSousFakeN3.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resSansAcUsage.valide).toBe(false);
    expect(resSansAcUsage.detailsEtapes.etape1ValiditeTemporelle).toBe(true);
    expect(resSansAcUsage.detailsEtapes.etape2ChaineEtSignatures).toBe(false);
    expect(resSansAcUsage.detailsEtapes.etape3StatutAv).toBe(true);
    expect(resSansAcUsage.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(true);
    expect(resSansAcUsage.detailsEtapes.messageDiagnostic).toContain('CERTIFICATION_AC');
  });
});

describe('Slice 5 — Échecs à l’Étape 3 (statut REVOQUE, SUSPENDU ou INCONNU du Certificat cible ou d’une AC Fille)', () => {
  it('rejette en Étape 3 un Certificat cible ou une AC Fille SUSPENDU, REVOQUE ou INCONNU auprès de l’AV et rétablit après Réactivation', async () => {
    const maintenant = new Date('2026-06-01T12:00:00Z');
    const horloge = () => maintenant;

    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker, { horloge });
    await annuaire.ready();

    const avMessagerie = new AutoriteValidation({
      nature: 'messagerie',
      broker,
      horloge
    });
    await avMessagerie.ready();

    const avRouteurs = new AutoriteValidation({
      nature: 'routeurs',
      broker,
      horloge
    });
    await avRouteurs.ready();

    const hierarchie = await amorcerHierarchieAc(broker, { horloge });
    const aeMsg = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'SecretP@ss2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'bob.dupont@dsi.organisation.fr',
          motDePasse: 'BobSecret#2026',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await aeMsg.ready();

    const aliceRep = await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: generateRsaKeyPair().publicKeyBase64
      }
    });
    const certAlice = (aliceRep.body as DemandeCertificationReponse).certificat!;

    const bobRep = await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'bob.dupont@dsi.organisation.fr',
        motDePasse: 'BobSecret#2026',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: generateRsaKeyPair().publicKeyBase64
      }
    });
    const certBob = (bobRep.body as DemandeCertificationReponse).certificat!;

    const transport = creerTransportPki(
      annuaire,
      new Map([
        ['messagerie', avMessagerie],
        ['routeurs', avRouteurs]
      ])
    );
    const client = new UtilisateurIcpClient(
      transport,
      hierarchie.racine.getCertificatAc(),
      horloge
    );

    // 1. Certificat d'Alice interrogé via une AV d'une autre nature ('routeurs') -> INCONNU
    const resInconnu = await client.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'routeurs',
      usageAttendu: 'SIGNATURE'
    });
    expect(resInconnu.valide).toBe(false);
    expect(resInconnu.statutCourant).toBe('INCONNU');
    expect(resInconnu.detailsEtapes.etape1ValiditeTemporelle).toBe(true);
    expect(resInconnu.detailsEtapes.etape2ChaineEtSignatures).toBe(true);
    expect(resInconnu.detailsEtapes.etape3StatutAv).toBe(false);
    expect(resInconnu.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(true);

    // 2. Suspension du Certificat cible (Alice) -> SUSPENDU
    await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'SUSPENSION',
        motif: 'SUSPENSION_TEMPORAIRE'
      }
    });
    const resSuspendu = await client.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resSuspendu.valide).toBe(false);
    expect(resSuspendu.statutCourant).toBe('SUSPENDU');
    expect(resSuspendu.detailsEtapes.etape3StatutAv).toBe(false);

    // 3. Réactivation d'Alice -> redevient VALIDE
    await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REACTIVATION',
        motif: 'FIN_SUSPENSION'
      }
    });
    const resReactive = await client.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resReactive.valide).toBe(true);
    expect(resReactive.statutCourant).toBe('VALIDE');

    // 4. Révocation définitive d'Alice -> REVOQUE
    await aeMsg.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION',
        motif: 'COMPROMISSION_CLE_PRIVEE'
      }
    });
    const resRevoque = await client.validerCertificat({
      numeroSerieCertificat: certAlice.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resRevoque.valide).toBe(false);
    expect(resRevoque.statutCourant).toBe('REVOQUE');
    expect(resRevoque.detailsEtapes.etape3StatutAv).toBe(false);

    // 5. Bob est VALIDE, mais son AC Fille N3 est révoquée par N2 -> Étape 3 échoue pour Bob !
    await hierarchie.directions.dsi.traiterInvalidation(
      hierarchie.services.dsiMessagerie.getCertificatAc().numeroSerie,
      'REVOCATION',
      'COMPROMISSION_CLE_PRIVEE'
    );
    const resAcFilleRevoquee = await client.validerCertificat({
      numeroSerieCertificat: certBob.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resAcFilleRevoquee.valide).toBe(false);
    expect(resAcFilleRevoquee.detailsEtapes.etape1ValiditeTemporelle).toBe(true);
    expect(resAcFilleRevoquee.detailsEtapes.etape2ChaineEtSignatures).toBe(true);
    expect(resAcFilleRevoquee.detailsEtapes.etape3StatutAv).toBe(false);
    expect(resAcFilleRevoquee.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(true);
    expect(resAcFilleRevoquee.detailsEtapes.messageDiagnostic).toContain('AC-N3-DSI-MESSAGERIE');
  });
});

describe('Slice 6 — Échecs à l’Étape 4 (politique d’usage et Sujet attendu)', () => {
  it('applique la compatibilité SIGNATURE_ET_CHIFFREMENT et rejette en Étape 4 un usage incompatible ou un Sujet différent', async () => {
    const maintenant = new Date('2026-06-01T12:00:00Z');
    const horloge = () => maintenant;

    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker, { horloge });
    await annuaire.ready();

    const avMessagerie = new AutoriteValidation({
      nature: 'messagerie',
      broker,
      horloge
    });
    await avMessagerie.ready();

    const hierarchie = await amorcerHierarchieAc(broker, { horloge });
    const aeMsg = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.signe@dsi.organisation.fr',
          motDePasse: 'Secret1!',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'bob.chiffre@dsi.organisation.fr',
          motDePasse: 'Secret2!',
          droitSignature: false,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'carole.mixte@dsi.organisation.fr',
          motDePasse: 'Secret3!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await aeMsg.ready();

    const certSigne = (
      (
        await aeMsg.handleRestRequest({
          method: 'POST',
          path: '/ae/messagerie/demandes-certification',
          body: {
            nomEntite: 'alice.signe@dsi.organisation.fr',
            motDePasse: 'Secret1!',
            usage: 'SIGNATURE',
            clePublique: generateRsaKeyPair().publicKeyBase64
          }
        })
      ).body as DemandeCertificationReponse
    ).certificat!;

    const certChiffre = (
      (
        await aeMsg.handleRestRequest({
          method: 'POST',
          path: '/ae/messagerie/demandes-certification',
          body: {
            nomEntite: 'bob.chiffre@dsi.organisation.fr',
            motDePasse: 'Secret2!',
            usage: 'CHIFFREMENT',
            clePublique: generateRsaKeyPair().publicKeyBase64
          }
        })
      ).body as DemandeCertificationReponse
    ).certificat!;

    const certMixte = (
      (
        await aeMsg.handleRestRequest({
          method: 'POST',
          path: '/ae/messagerie/demandes-certification',
          body: {
            nomEntite: 'carole.mixte@dsi.organisation.fr',
            motDePasse: 'Secret3!',
            usage: 'SIGNATURE_ET_CHIFFREMENT',
            clePublique: generateRsaKeyPair().publicKeyBase64
          }
        })
      ).body as DemandeCertificationReponse
    ).certificat!;

    const client = new UtilisateurIcpClient({
      transport: creerTransportPki(annuaire, new Map([['messagerie', avMessagerie]])),
      certificatAcRacine: hierarchie.racine.getCertificatAc(),
      horloge
    });

    // SIGNATURE_ET_CHIFFREMENT couvre SIGNATURE, CHIFFREMENT et SIGNATURE_ET_CHIFFREMENT
    for (const usageAttendu of [
      'SIGNATURE',
      'CHIFFREMENT',
      'SIGNATURE_ET_CHIFFREMENT'
    ] as const) {
      const rep = await client.validerCertificat({
        numeroSerieCertificat: certMixte.numeroSerie,
        natureRessource: 'messagerie',
        usageAttendu
      });
      expect(rep.valide).toBe(true);
    }

    // SIGNATURE seul échoue pour CHIFFREMENT et SIGNATURE_ET_CHIFFREMENT
    const resSignePourChiffre = await client.validerCertificat({
      numeroSerieCertificat: certSigne.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'CHIFFREMENT'
    });
    expect(resSignePourChiffre.valide).toBe(false);
    expect(resSignePourChiffre.detailsEtapes.etape1ValiditeTemporelle).toBe(true);
    expect(resSignePourChiffre.detailsEtapes.etape2ChaineEtSignatures).toBe(true);
    expect(resSignePourChiffre.detailsEtapes.etape3StatutAv).toBe(true);
    expect(resSignePourChiffre.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(false);

    // CHIFFREMENT seul échoue pour SIGNATURE
    const resChiffrePourSigne = await client.validerCertificat({
      numeroSerieCertificat: certChiffre.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE'
    });
    expect(resChiffrePourSigne.valide).toBe(false);
    expect(resChiffrePourSigne.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(false);

    // Sujet différent -> échoue à l'Étape 4
    const resMauvaisSujet = await client.validerCertificat({
      numeroSerieCertificat: certMixte.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'SIGNATURE',
      sujetAttendu: 'usurpateur@dsi.organisation.fr'
    });
    expect(resMauvaisSujet.valide).toBe(false);
    expect(resMauvaisSujet.detailsEtapes.etape1ValiditeTemporelle).toBe(true);
    expect(resMauvaisSujet.detailsEtapes.etape2ChaineEtSignatures).toBe(true);
    expect(resMauvaisSujet.detailsEtapes.etape3StatutAv).toBe(true);
    expect(resMauvaisSujet.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(false);
    expect(resMauvaisSujet.detailsEtapes.messageDiagnostic).toContain('usurpateur@dsi.organisation.fr');
  });
});
