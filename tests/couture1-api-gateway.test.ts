import { describe, it, expect } from 'vitest';
import {
  AMQP_EXCHANGES,
  AutoriteEnregistrement,
  AutoriteValidation,
  creerPlateformeComplete,
  generateRsaKeyPair,
  signMessageText,
  verifyCertificatSignature,
  verifyMessageSignature
} from '../src/index.js';
import type {
  Certificat,
  CheminCertificationReponse,
  DemandeCertificationReponse,
  DemandeRevocationReponse,
  ErreurApi,
  ListeCertificatsRevoques,
  StatutCertificatReponse
} from '../src/index.js';

describe('Couture 1 — API Gateway : façade REST unique et orchestration complète ICP', () => {
  it('couvre la hiérarchie AC 3 niveaux, enrôlements nominal et genererBicle, 401/403, corrélation AMQP 202->200, publications, Suspension/Réactivation/Révocation/409, ajout à chaud, TLS 403, 429 et X-Cache', async () => {
    const plateforme = await creerPlateformeComplete({
      exigerTls: true,
      rateLimit: { limiteRequetes: 15, fenetreMs: 60_000 },
      delaiReponseAcMs: 80,
      entitesParNature: {
        messagerie: [
          {
            nomEntite: 'alice.martin@dsi.organisation.fr',
            motDePasse: 'AliceSecret2026!',
            droitSignature: true,
            droitChiffrement: true,
            droitDemandeRevocation: true,
            acRattachementId: 'AC-N3-DSI-MESSAGERIE'
          },
          {
            nomEntite: 'stagiaire.lecture@dsi.organisation.fr',
            motDePasse: 'Stagiaire2026!',
            droitSignature: true,
            droitChiffrement: false,
            droitDemandeRevocation: false,
            acRattachementId: 'AC-N3-DSI-MESSAGERIE'
          }
        ],
        routeurs: [
          {
            nomEntite: 'routeur-coeur-01.infra.organisation.fr',
            motDePasse: 'RouteurSecret2026!',
            droitSignature: true,
            droitChiffrement: true,
            droitDemandeRevocation: true,
            acRattachementId: 'AC-N3-INFRA-RESEAU'
          }
        ]
      }
    });

    const { apiGateway, serviceDiscovery, hierarchie, broker, annuaire } = plateforme;
    const https = { 'x-forwarded-proto': 'https' };

    try {
      // 1. TLS obligatoire : rejet 403 sans x-forwarded-proto: https
      const repSansTls = await apiGateway.handleRequest({
        method: 'GET',
        path: '/api/v1/config/topologie-ac'
      });
      expect(repSansTls.status).toBe(403);
      expect((repSansTls.body as ErreurApi).code).toBe('TLS_REQUIS');

      // 2. Configuration Server via API Gateway : topologie AC 3 niveaux, ancre racine (cache MISS -> HIT), AMQP
      const repTopo = await apiGateway.handleRequest({
        method: 'GET',
        path: '/api/v1/config/topologie-ac',
        headers: https
      });
      expect(repTopo.status).toBe(200);
      const topo = repTopo.body as {
        acRacineId: string;
        profondeur: number;
        autorites: Array<{ acId: string; niveau: number }>;
      };
      expect(topo.acRacineId).toBe('AC-N1-RACINE');
      expect(topo.profondeur).toBe(3);
      expect(topo.autorites).toHaveLength(5);

      const repAncre1 = await apiGateway.handleRequest({
        method: 'GET',
        path: '/config/ancre-racine',
        headers: https
      });
      expect(repAncre1.status).toBe(200);
      expect(repAncre1.headers?.['X-Cache']).toBe('MISS');
      const racineCert = repAncre1.body as Certificat;
      expect(verifyCertificatSignature(racineCert, racineCert.clePublique)).toBe(true);

      const repAncre2 = await apiGateway.handleRequest({
        method: 'GET',
        path: '/api/v1/config/ancre-racine',
        headers: https
      });
      expect(repAncre2.status).toBe(200);
      expect(repAncre2.headers?.['X-Cache']).toBe('HIT');

      const repAmqp = await apiGateway.handleRequest({
        method: 'GET',
        path: '/config/amqp',
        headers: https
      });
      expect(repAmqp.status).toBe(200);
      expect(JSON.stringify(repAmqp.body)).toContain(AMQP_EXCHANGES.COMMANDES);
      expect(JSON.stringify(repAmqp.body)).toContain(AMQP_EXCHANGES.PUBLICATIONS);
      expect(JSON.stringify(repAmqp.body)).toContain(AMQP_EXCHANGES.CHAT_MESSAGES);

      // 3. Rejets 401 (authentification) et 403 (droits insuffisants)
      const bicleAlice = generateRsaKeyPair();
      const rep401 = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-certification',
        headers: https,
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'MauvaisMotDePasse',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: bicleAlice.publicKeyPem
        }
      });
      expect(rep401.status).toBe(401);

      const bicleStagiaire = generateRsaKeyPair();
      const rep403Droits = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-certification',
        headers: https,
        body: {
          nomEntite: 'stagiaire.lecture@dsi.organisation.fr',
          motDePasse: 'Stagiaire2026!',
          usage: 'CHIFFREMENT',
          clePublique: bicleStagiaire.publicKeyPem
        }
      });
      expect(rep403Droits.status).toBe(403);

      // 4. Enrôlement nominal Porteur (clé générée localement)
      const repEnrolAlice = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-certification',
        headers: https,
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AliceSecret2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: bicleAlice.publicKeyPem
        }
      });
      expect(repEnrolAlice.status).toBe(201);
      const bodyAlice = repEnrolAlice.body as DemandeCertificationReponse;
      expect(bodyAlice.statutDemande).toBe('EMISE');
      expect(bodyAlice.clePriveeGeneree).toBeNull();
      const certAlice = bodyAlice.certificat!;
      expect(certAlice.identifiantAcEmettrice).toBe('AC-N3-DSI-MESSAGERIE');

      // 5. Enrôlement routeur avec genererBicle: true (clé privée retournée une fois, opérationnelle)
      const repEnrolRouteur = await apiGateway.handleRequest({
        method: 'POST',
        path: '/ae/routeurs/demandes-certification',
        headers: https,
        body: {
          nomEntite: 'routeur-coeur-01.infra.organisation.fr',
          motDePasse: 'RouteurSecret2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          genererBicle: true
        }
      });
      expect(repEnrolRouteur.status).toBe(201);
      const bodyRouteur = repEnrolRouteur.body as DemandeCertificationReponse;
      expect(bodyRouteur.certificat?.identifiantAcEmettrice).toBe('AC-N3-INFRA-RESEAU');
      expect(typeof bodyRouteur.clePriveeGeneree).toBe('string');
      const sigRouteur = signMessageText('BGP-HELLO', bodyRouteur.clePriveeGeneree!);
      expect(
        verifyMessageSignature('BGP-HELLO', sigRouteur, bodyRouteur.certificat!.clePublique)
      ).toBe(true);

      // La consultation GET ultérieure ne redonne plus la clé privée
      const repGetDemandeRouteur = await apiGateway.handleRequest({
        method: 'GET',
        path: `/ae/routeurs/demandes-certification/${bodyRouteur.demandeId}`,
        headers: https
      });
      expect(repGetDemandeRouteur.status).toBe(200);
      expect((repGetDemandeRouteur.body as DemandeCertificationReponse).clePriveeGeneree).toBeNull();

      // 6. Corrélation AMQP ex.pki.commandes différée : 202 Accepted -> reprise AC -> 200 OK
      hierarchie.services.dsiMessagerie.suspendreConsommation();
      const repDifferee = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-certification',
        headers: https,
        body: {
          nomEntite: 'stagiaire.lecture@dsi.organisation.fr',
          motDePasse: 'Stagiaire2026!',
          usage: 'SIGNATURE',
          genererBicle: true
        }
      });
      expect(repDifferee.status).toBe(202);
      const location = repDifferee.headers?.Location;
      expect(location).toBeTruthy();

      await hierarchie.services.dsiMessagerie.reprendreConsommation();
      const repSuivi = await apiGateway.handleRequest({
        method: 'GET',
        path: location!,
        headers: https
      });
      expect(repSuivi.status).toBe(200);
      const bodySuivi = repSuivi.body as DemandeCertificationReponse;
      expect(bodySuivi.statutDemande).toBe('EMISE');
      expect(typeof bodySuivi.clePriveeGeneree).toBe('string');

      // 7. Annuaire & Chemin de certification (X-Cache MISS -> HIT) & statut AV
      const repChemin1 = await apiGateway.handleRequest({
        method: 'GET',
        path: `/api/v1/annuaire/certificats/${certAlice.numeroSerie}/chemin-certification`,
        headers: https
      });
      expect(repChemin1.status).toBe(200);
      expect(repChemin1.headers?.['X-Cache']).toBe('MISS');
      const chemin = repChemin1.body as CheminCertificationReponse;
      expect(chemin.profondeurHierarchie).toBe(3);
      expect(chemin.chaineCertificats.map((c) => c.sujet)).toEqual([
        'alice.martin@dsi.organisation.fr',
        'AC-N3-DSI-MESSAGERIE',
        'AC-N2-DSI',
        'AC-N1-RACINE'
      ]);

      const repChemin2 = await apiGateway.handleRequest({
        method: 'GET',
        path: `/annuaire/certificats/${certAlice.numeroSerie}/chemin-certification`,
        headers: https
      });
      expect(repChemin2.status).toBe(200);
      expect(repChemin2.headers?.['X-Cache']).toBe('HIT');

      const repAvInitial = await apiGateway.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certAlice.numeroSerie}/statut`,
        headers: https
      });
      expect(repAvInitial.status).toBe(200);
      expect((repAvInitial.body as StatutCertificatReponse).statut).toBe('VALIDE');

      // 8. Cycle de vie Suspension -> Réactivation -> Révocation définitive -> 409 sur Réactivation
      const repSusp = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-revocation',
        headers: https,
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AliceSecret2026!',
          numeroSerieCertificat: certAlice.numeroSerie,
          action: 'SUSPENSION',
          motif: 'SUSPENSION_TEMPORAIRE'
        }
      });
      expect(repSusp.status).toBe(200);
      expect((repSusp.body as DemandeRevocationReponse).nouvelEtatCertificat).toBe('SUSPENDU');

      const repAvSusp = await apiGateway.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certAlice.numeroSerie}/statut`,
        headers: https
      });
      expect((repAvSusp.body as StatutCertificatReponse).statut).toBe('SUSPENDU');

      const repReact = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-revocation',
        headers: https,
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AliceSecret2026!',
          numeroSerieCertificat: certAlice.numeroSerie,
          action: 'REACTIVATION',
          motif: 'FIN_SUSPENSION'
        }
      });
      expect(repReact.status).toBe(200);
      expect((repReact.body as DemandeRevocationReponse).nouvelEtatCertificat).toBe('VALIDE');

      const repRevoc = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-revocation',
        headers: https,
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AliceSecret2026!',
          numeroSerieCertificat: certAlice.numeroSerie,
          action: 'REVOCATION',
          motif: 'COMPROMISSION_CLE_PRIVEE'
        }
      });
      expect(repRevoc.status).toBe(200);
      expect((repRevoc.body as DemandeRevocationReponse).nouvelEtatCertificat).toBe('REVOQUE');

      const repAvRevoc = await apiGateway.handleRequest({
        method: 'GET',
        path: `/av/messagerie/certificats/${certAlice.numeroSerie}/statut`,
        headers: https
      });
      expect((repAvRevoc.body as StatutCertificatReponse).statut).toBe('REVOQUE');

      const repLcr = await apiGateway.handleRequest({
        method: 'GET',
        path: '/annuaire/autorites/AC-N3-DSI-MESSAGERIE/lcr',
        headers: https
      });
      expect(repLcr.status).toBe(200);
      expect(
        (repLcr.body as ListeCertificatsRevoques).entrees.some(
          (e) => e.numeroSerieCertificat === certAlice.numeroSerie && e.statut === 'REVOQUE'
        )
      ).toBe(true);

      const rep409 = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-revocation',
        headers: https,
        body: {
          nomEntite: 'alice.martin@dsi.organisation.fr',
          motDePasse: 'AliceSecret2026!',
          numeroSerieCertificat: certAlice.numeroSerie,
          action: 'REACTIVATION'
        }
      });
      expect(rep409.status).toBe(409);

      // 9. Ajout à chaud d'une nouvelle nature dans ServiceDiscovery -> immédiatement routable
      const avBadgeuse = new AutoriteValidation({ nature: 'badgeuses', broker });
      await avBadgeuse.ready();
      const aeBadgeuse = new AutoriteEnregistrement({
        nature: 'badgeuses',
        broker,
        servicePublication: annuaire,
        entites: [
          {
            nomEntite: 'badgeuse-hall-a@infra.organisation.fr',
            motDePasse: 'BadgeSecret!',
            droitSignature: true,
            droitChiffrement: false,
            droitDemandeRevocation: true,
            acRattachementId: 'AC-N3-INFRA-RESEAU'
          }
        ]
      });
      await aeBadgeuse.ready();
      serviceDiscovery.enregistrerNature('badgeuses', {
        ae: aeBadgeuse,
        av: avBadgeuse
      });

      const repBadgeCert = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/badgeuses/demandes-certification',
        headers: https,
        body: {
          nomEntite: 'badgeuse-hall-a@infra.organisation.fr',
          motDePasse: 'BadgeSecret!',
          usage: 'SIGNATURE',
          genererBicle: true
        }
      });
      expect(repBadgeCert.status).toBe(201);
      const certBadge = (repBadgeCert.body as DemandeCertificationReponse).certificat!;

      const repBadgeStatut = await apiGateway.handleRequest({
        method: 'GET',
        path: `/av/badgeuses/certificats/${certBadge.numeroSerie}/statut`,
        headers: https
      });
      expect(repBadgeStatut.status).toBe(200);
      expect((repBadgeStatut.body as StatutCertificatReponse).statut).toBe('VALIDE');

      await aeBadgeuse.arreter();
      await avBadgeuse.arreter();

      // 10. Rate-limiting 429 sur endpoint AE sensible (client dédié avec x-client-id)
      const rlHeaders = { ...https, 'x-client-id': 'rafale-test' };
      let derniereReponseStatus = 0;
      for (let i = 0; i < 16; i += 1) {
        const rep = await apiGateway.handleRequest({
          method: 'POST',
          path: '/ae/routeurs/demandes-revocation',
          headers: rlHeaders,
          body: {}
        });
        derniereReponseStatus = rep.status;
      }
      expect(derniereReponseStatus).toBe(429);
    } finally {
      await plateforme.arreter();
    }
  });
});
