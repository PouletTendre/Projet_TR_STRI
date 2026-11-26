import { describe, it, expect } from 'vitest';
import {
  AMQP_EXCHANGES,
  AutoriteEnregistrement,
  InMemoryAmqpBroker,
  ServicePublication,
  amorcerHierarchieAc,
  generateRsaKeyPair,
  verifyLcrSignature
} from '../src/index.js';
import type {
  AmqpMessage,
  Certificat,
  DemandeCertificationReponse,
  DemandeRevocationReponse,
  ErreurApi,
  ListeCertificatsRevoques,
  PublicationLcrPayload
} from '../src/index.js';

describe('Slice 1 — Cycle de vie Suspension -> Réactivation -> Révocation et diffusion LCR temps réel', () => {
  it('permet à un Porteur autorisé de suspendre, réactiver puis révoquer son Certificat via POST /ae/{nature}/demandes-revocation et diffuse chaque LCR signée sur lcr.<acId>', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker);
    const acMsg = hierarchie.services.dsiMessagerie;

    // File d'audit abonnée exactement à lcr.AC-N3-DSI-MESSAGERIE sur ex.pki.publications
    broker.declareQueue('q.audit.lcr.dsi-msg', { durable: true });
    broker.bindQueue(
      'q.audit.lcr.dsi-msg',
      AMQP_EXCHANGES.PUBLICATIONS,
      `lcr.${acMsg.acId}`
    );
    const lcrsDiffusees: AmqpMessage<PublicationLcrPayload>[] = [];
    await broker.consume<PublicationLcrPayload>('q.audit.lcr.dsi-msg', (msg) => {
      lcrsDiffusees.push(msg);
    });

    const ae = new AutoriteEnregistrement({
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
    await ae.ready();

    // Enrôlement préalable d'Alice
    const aliceKeys = generateRsaKeyPair();
    const repEnrol = await ae.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: aliceKeys.publicKeyBase64
      }
    });
    expect(repEnrol.status).toBe(201);
    const certAlice = (repEnrol.body as DemandeCertificationReponse).certificat!;

    // Version initiale de la LCR = 1 (publiée à l'amorçage)
    const lcrInitRep = annuaire.handleRestRequest({
      method: 'GET',
      path: `/annuaire/autorites/${acMsg.acId}/lcr`
    });
    expect(lcrInitRep.status).toBe(200);
    const versionInitiale = (lcrInitRep.body as ListeCertificatsRevoques).numeroVersionLcr;

    // 1. SUSPENSION
    const repSusp = await ae.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'SUSPENSION',
        motif: 'SUSPENSION_TEMPORAIRE'
      }
    });
    expect(repSusp.status).toBe(200);
    const bodySusp = repSusp.body as DemandeRevocationReponse;
    expect(bodySusp.demandeId).toBeTruthy();
    expect(bodySusp.numeroSerieCertificat).toBe(certAlice.numeroSerie);
    expect(bodySusp.identifiantAc).toBe(acMsg.acId);
    expect(bodySusp.actionAppliquee).toBe('SUSPENSION');
    expect(bodySusp.nouvelEtatCertificat).toBe('SUSPENDU');
    expect(bodySusp.horodatagePublicationLcr).toBeTruthy();

    // LCR diffusée en temps réel sur ex.pki.publications (lcr.<acId>)
    expect(lcrsDiffusees).toHaveLength(1);
    expect(lcrsDiffusees[0]?.properties.type).toBe('PUBLICATION_LCR');
    expect(lcrsDiffusees[0]?.routingKey).toBe(`lcr.${acMsg.acId}`);
    const lcrSusp = lcrsDiffusees[0]!.payload.lcr;
    expect(lcrSusp.numeroVersionLcr).toBe(versionInitiale + 1);
    expect(verifyLcrSignature(lcrSusp, acMsg.clePubliqueBase64)).toBe(true);
    expect(lcrSusp.entrees).toHaveLength(1);
    expect(lcrSusp.entrees[0]).toMatchObject({
      numeroSerieCertificat: certAlice.numeroSerie,
      statut: 'SUSPENDU',
      motif: 'SUSPENSION_TEMPORAIRE'
    });

    // Annuaire reflète la suspension (/annuaire/autorites/{acId}/lcr, /annuaire/lcr, uniquementValides=true)
    const annuaireLcrSusp = annuaire.handleRestRequest({
      method: 'GET',
      path: `/annuaire/autorites/${acMsg.acId}/lcr`
    });
    expect(annuaireLcrSusp.status).toBe(200);
    expect((annuaireLcrSusp.body as ListeCertificatsRevoques).numeroVersionLcr).toBe(
      versionInitiale + 1
    );

    const annuaireValidesSusp = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: 'alice.martin@dsi.organisation.fr', uniquementValides: true }
    });
    expect(annuaireValidesSusp.status).toBe(200);
    expect(annuaireValidesSusp.body as Certificat[]).toHaveLength(0);

    // 2. REACTIVATION
    const repReact = await ae.handleRestRequest({
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
    expect(repReact.status).toBe(200);
    const bodyReact = repReact.body as DemandeRevocationReponse;
    expect(bodyReact.actionAppliquee).toBe('REACTIVATION');
    expect(bodyReact.nouvelEtatCertificat).toBe('VALIDE');

    expect(lcrsDiffusees).toHaveLength(2);
    const lcrReact = lcrsDiffusees[1]!.payload.lcr;
    expect(lcrReact.numeroVersionLcr).toBe(versionInitiale + 2);
    expect(verifyLcrSignature(lcrReact, acMsg.clePubliqueBase64)).toBe(true);
    expect(lcrReact.entrees).toHaveLength(0);

    const annuaireValidesReact = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: 'alice.martin@dsi.organisation.fr', uniquementValides: true }
    });
    expect(annuaireValidesReact.status).toBe(200);
    expect(annuaireValidesReact.body as Certificat[]).toHaveLength(1);

    // 3. REVOCATION définitive
    const repRevoc = await ae.handleRestRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'SecretP@ss2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION',
        motif: 'COMPROMISSION_CLE_PRIVEE'
      }
    });
    expect(repRevoc.status).toBe(200);
    const bodyRevoc = repRevoc.body as DemandeRevocationReponse;
    expect(bodyRevoc.actionAppliquee).toBe('REVOCATION');
    expect(bodyRevoc.nouvelEtatCertificat).toBe('REVOQUE');

    expect(lcrsDiffusees).toHaveLength(3);
    const lcrRevoc = lcrsDiffusees[2]!.payload.lcr;
    expect(lcrRevoc.numeroVersionLcr).toBe(versionInitiale + 3);
    expect(verifyLcrSignature(lcrRevoc, acMsg.clePubliqueBase64)).toBe(true);
    expect(lcrRevoc.entrees).toHaveLength(1);
    expect(lcrRevoc.entrees[0]).toMatchObject({
      numeroSerieCertificat: certAlice.numeroSerie,
      statut: 'REVOQUE',
      motif: 'COMPROMISSION_CLE_PRIVEE'
    });

    // /annuaire/lcr consolidée contient la dernière version pour acMsg.acId
    const annuaireConsolide = annuaire.handleRestRequest({
      method: 'GET',
      path: '/api/v1/annuaire/lcr'
    });
    expect(annuaireConsolide.status).toBe(200);
    const lcrAcDansConsolide = (annuaireConsolide.body as ListeCertificatsRevoques[]).find(
      (l) => l.identifiantAc === acMsg.acId
    );
    expect(lcrAcDansConsolide?.numeroVersionLcr).toBe(versionInitiale + 3);
    expect(lcrAcDansConsolide?.entrees).toHaveLength(1);

    const annuaireValidesRevoc = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: 'alice.martin@dsi.organisation.fr', uniquementValides: true }
    });
    expect(annuaireValidesRevoc.status).toBe(200);
    expect(annuaireValidesRevoc.body as Certificat[]).toHaveLength(0);
  });
});

describe('Slice 2 — Rejets côté AE avant routage AMQP vers l’AC (400 / 401 / 403 / 404)', () => {
  it('rejette les demandes invalides (400), non authentifiées (401), sans droit de révocation (403), sur le certificat d’un tiers (403) ou certificat inconnu (404) sans jamais atteindre l’AC', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker);
    const acMsg = hierarchie.services.dsiMessagerie;

    const ae = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AlicePass#2026',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'bob.sansrevocation@dsi.organisation.fr',
          motDePasse: 'BobPass#2026',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: false,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'charlie.tiers@dsi.organisation.fr',
          motDePasse: 'CharliePass#2026',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await ae.ready();

    const aliceKeys = generateRsaKeyPair();
    const bobKeys = generateRsaKeyPair();

    const repAlice = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        usage: 'SIGNATURE',
        clePublique: aliceKeys.publicKeyBase64
      }
    });
    expect(repAlice.status).toBe(201);
    const certAlice = (repAlice.body as DemandeCertificationReponse).certificat!;

    const repBob = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'bob.sansrevocation@dsi.organisation.fr',
        motDePasse: 'BobPass#2026',
        usage: 'SIGNATURE',
        clePublique: bobKeys.publicKeyBase64
      }
    });
    expect(repBob.status).toBe(201);
    const certBob = (repBob.body as DemandeCertificationReponse).certificat!;

    // On suspend la consommation AC pour prouver qu'aucune commande AMQP n'est déposée dans la file AC
    acMsg.suspendreConsommation();
    const versionAvant = acMsg.getLcrCourante().numeroVersionLcr;

    // 400 : action invalide
    const repActionInvalide = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'SUPPRESSION'
      }
    });
    expect(repActionInvalide.status).toBe(400);

    // 401 : mauvais mot de passe
    const repMauvaisMdp = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'MauvaisMotDePasse',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION'
      }
    });
    expect(repMauvaisMdp.status).toBe(401);
    expect((repMauvaisMdp.body as ErreurApi).code).toBe('NON_AUTHENTIFIE');

    // 401 : entité inconnue
    const repInconnu = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'intrus@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION'
      }
    });
    expect(repInconnu.status).toBe(401);

    // 403 : droitDemandeRevocation = false
    const repSansDroit = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'bob.sansrevocation@dsi.organisation.fr',
        motDePasse: 'BobPass#2026',
        numeroSerieCertificat: certBob.numeroSerie,
        action: 'REVOCATION'
      }
    });
    expect(repSansDroit.status).toBe(403);
    expect((repSansDroit.body as ErreurApi).code).toBe('DROITS_INSUFFISANTS');

    // 403 : tentative sur le Certificat d'un tiers (Charlie a le droit, mais cible le certificat d'Alice)
    const repTiers = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'charlie.tiers@dsi.organisation.fr',
        motDePasse: 'CharliePass#2026',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION'
      }
    });
    expect(repTiers.status).toBe(403);
    expect((repTiers.body as ErreurApi).code).toBe('DROITS_INSUFFISANTS');

    // 404 : certificat introuvable
    const repCertInconnu = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: 'SN-INEXISTANT-999999',
        action: 'REVOCATION'
      }
    });
    expect(repCertInconnu.status).toBe(404);
    expect((repCertInconnu.body as ErreurApi).code).toBe('CERTIFICAT_INTROUVABLE');

    // Aucun message n'a été publié vers la file de l'AC et la LCR est restée intacte
    const queueAc = broker
      .listQueues()
      .find((q) => q.name === `q.pki.ac.${acMsg.acId}.demandes`);
    expect(queueAc?.bufferedCount).toBe(0);
    expect(acMsg.getLcrCourante().numeroVersionLcr).toBe(versionAvant);
  });
});

describe('Slice 3 — Machine d’états stricte de l’AC et rejets 409 Conflict (REVOQUE irréversible, transitions redondantes, Certificat expiré)', () => {
  it('rejette en 409 toute Réactivation d’un Certificat REVOQUE, toute transition invalide et toute invalidation d’un Certificat déjà expiré', async () => {
    let maintenant = new Date('2026-01-01T10:00:00Z');
    const horloge = () => maintenant;

    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker, { horloge });
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker, {
      dateDebut: maintenant,
      horloge
    });
    const acMsg = hierarchie.services.dsiMessagerie;

    const ae = new AutoriteEnregistrement({
      nature: 'messagerie',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AlicePass#2026',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: 'bob.expire@dsi.organisation.fr',
          motDePasse: 'BobExpire#2026',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ]
    });
    await ae.ready();

    const aliceKeys = generateRsaKeyPair();
    const bobKeys = generateRsaKeyPair();

    const repAlice = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        usage: 'SIGNATURE',
        clePublique: aliceKeys.publicKeyBase64
      }
    });
    expect(repAlice.status).toBe(201);
    const certAlice = (repAlice.body as DemandeCertificationReponse).certificat!;

    const repBob = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite: 'bob.expire@dsi.organisation.fr',
        motDePasse: 'BobExpire#2026',
        usage: 'SIGNATURE',
        clePublique: bobKeys.publicKeyBase64
      }
    });
    expect(repBob.status).toBe(201);
    const certBob = (repBob.body as DemandeCertificationReponse).certificat!;

    const versionInitiale = acMsg.getLcrCourante().numeroVersionLcr;

    // 1. REACTIVATION sur un Certificat encore VALIDE -> 409 TRANSITION_INVALIDE
    const repReactValide = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REACTIVATION'
      }
    });
    expect(repReactValide.status).toBe(409);
    expect((repReactValide.body as ErreurApi).code).toBe('TRANSITION_INVALIDE');
    expect(acMsg.getLcrCourante().numeroVersionLcr).toBe(versionInitiale);

    // 2. SUSPENSION puis seconde SUSPENSION redondante -> 409 TRANSITION_INVALIDE
    const repSusp = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'SUSPENSION'
      }
    });
    expect(repSusp.status).toBe(200);
    const versionApresSusp = acMsg.getLcrCourante().numeroVersionLcr;
    expect(versionApresSusp).toBe(versionInitiale + 1);

    const repDoubleSusp = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'SUSPENSION'
      }
    });
    expect(repDoubleSusp.status).toBe(409);
    expect((repDoubleSusp.body as ErreurApi).code).toBe('TRANSITION_INVALIDE');
    expect(acMsg.getLcrCourante().numeroVersionLcr).toBe(versionApresSusp);

    // 3. REVOCATION définitive depuis SUSPENDU, puis tentative de REACTIVATION / SUSPENSION / REVOCATION -> 409 TRANSITION_INVALIDE
    const repRevoc = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: 'alice.martin@dsi.organisation.fr',
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION',
        motif: 'COMPROMISSION_CLE_PRIVEE'
      }
    });
    expect(repRevoc.status).toBe(200);
    const versionApresRevoc = acMsg.getLcrCourante().numeroVersionLcr;
    expect(versionApresRevoc).toBe(versionApresSusp + 1);

    for (const actionInterdite of ['REACTIVATION', 'SUSPENSION', 'REVOCATION'] as const) {
      const repApresRevoc = await ae.handleRestRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AlicePass#2026',
          numeroSerieCertificat: certAlice.numeroSerie,
          action: actionInterdite
        }
      });
      expect(repApresRevoc.status).toBe(409);
      expect((repApresRevoc.body as ErreurApi).code).toBe('TRANSITION_INVALIDE');
    }
    expect(acMsg.getLcrCourante().numeroVersionLcr).toBe(versionApresRevoc);

    // 4. Avance de l'horloge au-delà de dateFinValidite de Bob (365 jours -> +400 jours)
    maintenant = new Date('2027-02-05T10:00:00Z');

    // Le certificat expiré de Bob n'apparaît plus dans uniquementValides=true
    const annuaireValidesBob = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: 'bob.expire@dsi.organisation.fr', uniquementValides: true }
    });
    expect(annuaireValidesBob.status).toBe(200);
    expect(annuaireValidesBob.body as Certificat[]).toHaveLength(0);

    // Toute tentative de REVOCATION, SUSPENSION ou REACTIVATION sur un Certificat expiré -> 409 CERTIFICAT_EXPIRE
    for (const actionExpiree of ['REVOCATION', 'SUSPENSION', 'REACTIVATION'] as const) {
      const repExpire = await ae.handleRestRequest({
        method: 'POST',
        path: '/ae/messagerie/demandes-revocation',
        body: {
          nomEntite: 'bob.expire@dsi.organisation.fr',
          motDePasse: 'BobExpire#2026',
          numeroSerieCertificat: certBob.numeroSerie,
          action: actionExpiree
        }
      });
      expect(repExpire.status).toBe(409);
      expect((repExpire.body as ErreurApi).code).toBe('CERTIFICAT_EXPIRE');
    }
    expect(acMsg.getLcrCourante().numeroVersionLcr).toBe(versionApresRevoc);
  });
});

describe('Slice 4 — Révocation et Suspension d’une AC Fille (niveau 2 ou 3) dans la LCR de son AC parente', () => {
  it('révoque une AC Fille de niveau 3 dans la LCR de son AC parente N2 et suspend/révoque une AC Fille N2 dans la LCR de l’AC Racine N1', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();

    const hierarchie = await amorcerHierarchieAc(broker);
    const { racine } = hierarchie;
    const { dsi, infra } = hierarchie.directions;
    const { dsiMessagerie } = hierarchie.services;

    // File d'audit abonnée à toutes les publications LCR (lcr.#)
    broker.declareQueue('q.audit.lcr.toutes', { durable: true });
    broker.bindQueue('q.audit.lcr.toutes', AMQP_EXCHANGES.PUBLICATIONS, 'lcr.#');
    const publicationsLcr: AmqpMessage<PublicationLcrPayload>[] = [];
    await broker.consume<PublicationLcrPayload>('q.audit.lcr.toutes', (msg) => {
      publicationsLcr.push(msg);
    });

    const certN3Msg = dsiMessagerie.getCertificatAc();
    const certN2Infra = infra.getCertificatAc();

    // 1. AC-N2-DSI révoque sa fille AC-N3-DSI-MESSAGERIE (niveau 3)
    const versionDsiInit = dsi.getLcrCourante().numeroVersionLcr;
    const resRevocN3 = await dsi.traiterInvalidation(
      certN3Msg.numeroSerie,
      'REVOCATION',
      'COMPROMISSION_CLE_PRIVEE'
    );
    expect(resRevocN3.succes).toBe(true);
    if (resRevocN3.succes) {
      expect(resRevocN3.nouvelEtatCertificat).toBe('REVOQUE');
      expect(resRevocN3.lcr.numeroVersionLcr).toBe(versionDsiInit + 1);
      expect(verifyLcrSignature(resRevocN3.lcr, dsi.clePubliqueBase64)).toBe(true);
    }

    expect(publicationsLcr).toHaveLength(1);
    expect(publicationsLcr[0]?.routingKey).toBe(`lcr.${dsi.acId}`);
    expect(publicationsLcr[0]?.properties.type).toBe('PUBLICATION_LCR');

    const repLcrDsi = annuaire.handleRestRequest({
      method: 'GET',
      path: `/annuaire/autorites/${dsi.acId}/lcr`
    });
    expect(repLcrDsi.status).toBe(200);
    const lcrDsi = repLcrDsi.body as ListeCertificatsRevoques;
    expect(lcrDsi.numeroVersionLcr).toBe(versionDsiInit + 1);
    expect(lcrDsi.entrees).toHaveLength(1);
    expect(lcrDsi.entrees[0]).toMatchObject({
      numeroSerieCertificat: certN3Msg.numeroSerie,
      statut: 'REVOQUE',
      motif: 'COMPROMISSION_CLE_PRIVEE'
    });

    // Le certificat de AC-N3-DSI-MESSAGERIE est exclu de uniquementValides=true
    const repCertN3Valide = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: dsiMessagerie.acId, uniquementValides: true }
    });
    expect(repCertN3Valide.status).toBe(200);
    expect(repCertN3Valide.body as Certificat[]).toHaveLength(0);

    const repCertN3Tous = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: dsiMessagerie.acId, uniquementValides: false }
    });
    expect(repCertN3Tous.status).toBe(200);
    expect(repCertN3Tous.body as Certificat[]).toHaveLength(1);

    // 2. AC-N1-RACINE suspend puis révoque sa fille AC-N2-INFRA (niveau 2)
    const versionRacineInit = racine.getLcrCourante().numeroVersionLcr;
    const resSuspN2 = await racine.traiterInvalidation(
      certN2Infra.numeroSerie,
      'SUSPENSION',
      'SUSPENSION_TEMPORAIRE'
    );
    expect(resSuspN2.succes).toBe(true);

    const resRevocN2 = await racine.traiterInvalidation(
      certN2Infra.numeroSerie,
      'REVOCATION',
      'CESSATION_ACTIVITE'
    );
    expect(resRevocN2.succes).toBe(true);

    // Tentative de réactivation de AC-N2-INFRA après révocation -> 409 TRANSITION_INVALIDE
    const resReactN2 = await racine.traiterInvalidation(
      certN2Infra.numeroSerie,
      'REACTIVATION'
    );
    expect(resReactN2.succes).toBe(false);
    if (!resReactN2.succes) {
      expect(resReactN2.httpStatus).toBe(409);
      expect(resReactN2.code).toBe('TRANSITION_INVALIDE');
    }

    expect(publicationsLcr).toHaveLength(3);
    expect(publicationsLcr[1]?.routingKey).toBe(`lcr.${racine.acId}`);
    expect(publicationsLcr[2]?.routingKey).toBe(`lcr.${racine.acId}`);

    const repLcrConsolide = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/lcr'
    });
    expect(repLcrConsolide.status).toBe(200);
    const lcrRacine = (repLcrConsolide.body as ListeCertificatsRevoques[]).find(
      (l) => l.identifiantAc === racine.acId
    );
    expect(lcrRacine?.numeroVersionLcr).toBe(versionRacineInit + 2);
    expect(verifyLcrSignature(lcrRacine!, racine.clePubliqueBase64)).toBe(true);
    expect(lcrRacine?.entrees).toHaveLength(1);
    expect(lcrRacine?.entrees[0]).toMatchObject({
      numeroSerieCertificat: certN2Infra.numeroSerie,
      statut: 'REVOQUE',
      motif: 'CESSATION_ACTIVITE'
    });

    const repCertN2Valide = annuaire.handleRestRequest({
      method: 'GET',
      path: '/annuaire/certificats',
      query: { sujet: infra.acId, uniquementValides: true }
    });
    expect(repCertN2Valide.status).toBe(200);
    expect(repCertN2Valide.body as Certificat[]).toHaveLength(0);
  });
});
