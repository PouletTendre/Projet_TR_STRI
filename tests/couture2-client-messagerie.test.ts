import { describe, it, expect } from 'vitest';
import {
  AMQP_EXCHANGES,
  CorrespondantClient,
  ErreurAclEdge,
  ErreurSessionFermee,
  ErreurValidationCorrespondant,
  UtilisateurIcpClient,
  creerPlateformeComplete,
  generateRsaKeyPair
} from '../src/index.js';
import type {
  Certificat,
  DemandeCertificationReponse,
  NiveauSecurite
} from '../src/index.js';

describe('Couture 2 — UtilisateurIcpClient & CorrespondantClient derrière API Gateway + Passerelle Edge Messagerie', () => {
  it('valide en 4 étapes via API Gateway, exécute les 4 niveaux de sécurité clos par FIN_MSG, bloque après révocation en cours de session et applique les ACL Edge strictes', async () => {
    const aliceId = 'alice.martin@dsi.organisation.fr';
    const bobId = 'bob.dupont@dsi.organisation.fr';
    const charlieId = 'charlie.lefevre@dsi.organisation.fr';

    const plateforme = await creerPlateformeComplete({
      exigerTls: true,
      rateLimit: { limiteRequetes: 50, fenetreMs: 60_000 },
      entitesParNature: {
        messagerie: [
          {
            nomEntite: aliceId,
            motDePasse: 'AlicePass2026!',
            droitSignature: true,
            droitChiffrement: true,
            droitDemandeRevocation: true,
            acRattachementId: 'AC-N3-DSI-MESSAGERIE'
          },
          {
            nomEntite: bobId,
            motDePasse: 'BobPass2026!',
            droitSignature: true,
            droitChiffrement: true,
            droitDemandeRevocation: true,
            acRattachementId: 'AC-N3-DSI-MESSAGERIE'
          },
          {
            nomEntite: charlieId,
            motDePasse: 'CharliePass2026!',
            droitSignature: true,
            droitChiffrement: false,
            droitDemandeRevocation: true,
            acRattachementId: 'AC-N3-DSI-MESSAGERIE'
          }
        ]
      }
    });

    const { apiGateway, passerelleMessagerie } = plateforme;
    const https = { 'x-forwarded-proto': 'https' };

    try {
      // Récupération de l'ancre AC Racine via ConfigurationServer exposé par API Gateway
      const repAncre = await apiGateway.handleRequest({
        method: 'GET',
        path: '/api/v1/config/ancre-racine',
        headers: https
      });
      expect(repAncre.status).toBe(200);
      const ancreRacine = repAncre.body as Certificat;

      // Enrôlement d'Alice, Bob (SIGNATURE_ET_CHIFFREMENT) et Charlie (SIGNATURE uniquement) via API Gateway
      const bicleAlice = generateRsaKeyPair();
      const repAlice = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-certification',
        headers: https,
        body: {
          nomEntite: aliceId,
          motDePasse: 'AlicePass2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: bicleAlice.publicKeyPem
        }
      });
      expect(repAlice.status).toBe(201);
      const certAlice = (repAlice.body as DemandeCertificationReponse).certificat!;

      const bicleBob = generateRsaKeyPair();
      const repBob = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-certification',
        headers: https,
        body: {
          nomEntite: bobId,
          motDePasse: 'BobPass2026!',
          usage: 'SIGNATURE_ET_CHIFFREMENT',
          clePublique: bicleBob.publicKeyPem
        }
      });
      expect(repBob.status).toBe(201);
      const certBob = (repBob.body as DemandeCertificationReponse).certificat!;

      const repCharlie = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-certification',
        headers: https,
        body: {
          nomEntite: charlieId,
          motDePasse: 'CharliePass2026!',
          usage: 'SIGNATURE',
          genererBicle: true
        }
      });
      expect(repCharlie.status).toBe(201);
      const certCharlie = (repCharlie.body as DemandeCertificationReponse).certificat!;

      // Client Utilisateur ICP raccordé exclusivement à l'API Gateway
      const transportRest = apiGateway.transport(https);
      const utilisateurIcp = new UtilisateurIcpClient({
        transport: transportRest,
        certificatAcRacine: ancreRacine
      });

      // 1. Validation en 4 étapes via API Gateway (succès et échec étape 4 usage/sujet)
      const valBobOk = await utilisateurIcp.validerCertificat({
        numeroSerieCertificat: certBob.numeroSerie,
        natureRessource: 'messagerie',
        usageAttendu: 'CHIFFREMENT',
        sujetAttendu: bobId
      });
      expect(valBobOk.valide).toBe(true);
      expect(valBobOk.detailsEtapes).toMatchObject({
        etape1ValiditeTemporelle: true,
        etape2ChaineEtSignatures: true,
        etape3StatutAv: true,
        etape4PolitiqueUsageEtSujet: true
      });

      const valCharlieKo = await utilisateurIcp.validerCertificat({
        numeroSerieCertificat: certCharlie.numeroSerie,
        natureRessource: 'messagerie',
        usageAttendu: 'CHIFFREMENT',
        sujetAttendu: charlieId
      });
      expect(valCharlieKo.valide).toBe(false);
      expect(valCharlieKo.detailsEtapes.etape4PolitiqueUsageEtSujet).toBe(false);

      // 2. CorrespondantClient Alice & Bob câblés derrière API Gateway + Passerelle Edge Messagerie
      const transportChatAlice = passerelleMessagerie.creerTransportPourCorrespondant(aliceId);
      const transportChatBob = passerelleMessagerie.creerTransportPourCorrespondant(bobId);

      const alice = new CorrespondantClient({
        correspondantId: aliceId,
        natureRessource: 'messagerie',
        transport: transportChatAlice,
        utilisateurIcp,
        certificat: certAlice,
        clePrivee: bicleAlice.privateKeyPem
      });
      const bob = new CorrespondantClient({
        correspondantId: bobId,
        natureRessource: 'messagerie',
        transport: transportChatBob,
        utilisateurIcp,
        certificat: certBob,
        clePrivee: bicleBob.privateKeyPem
      });

      await alice.ready();
      await bob.ready();

      // 3. Parcours des 4 niveaux de sécurité + clôture FIN_MSG
      const niveaux: NiveauSecurite[] = [
        'NON_SECURISE',
        'SIGNE',
        'CHIFFRE',
        'SIGNE_ET_CHIFFRE'
      ];

      for (const niveau of niveaux) {
        const ouverture = await alice.ouvrirEchange(
          bobId,
          niveau,
          `Ouverture ${niveau}`
        );
        const reponse = await bob.envoyerMessage(
          ouverture.echangeId,
          `Réponse ${niveau}`
        );
        expect(reponse.niveauSecurite).toBe(niveau);

        const cloture = await alice.cloreEchange(ouverture.echangeId);
        expect(cloture.typeMessage).toBe('FIN_MSG');
        expect(cloture.sessionFermee).toBe(true);

        await expect(
          bob.envoyerMessage(ouverture.echangeId, 'Message hors session')
        ).rejects.toThrow(ErreurSessionFermee);
      }

      const recusBob = bob.getMessagesRecus();
      const recusAlice = alice.getMessagesRecus();
      for (const niveau of niveaux) {
        expect(recusBob.some((m) => m.contenu === `Ouverture ${niveau}`)).toBe(true);
        expect(recusAlice.some((m) => m.contenu === `Réponse ${niveau}`)).toBe(true);
      }

      // 4. Révocation en cours de session : un Échange SIGNE_ET_CHIFFRE actif rejette immédiatement après révocation de Bob
      const sessionActive = await alice.ouvrirEchange(
        bobId,
        'SIGNE_ET_CHIFFRE',
        'Message avant révocation'
      );

      const repRevocBob = await apiGateway.handleRequest({
        method: 'POST',
        path: '/api/v1/ae/messagerie/demandes-revocation',
        headers: https,
        body: {
          nomEntite: bobId,
          motDePasse: 'BobPass2026!',
          numeroSerieCertificat: certBob.numeroSerie,
          action: 'REVOCATION',
          motif: 'COMPROMISSION_CLE_PRIVEE'
        }
      });
      expect(repRevocBob.status).toBe(200);

      await expect(
        alice.envoyerMessage(sessionActive.echangeId, 'Message après révocation')
      ).rejects.toThrow(ErreurValidationCorrespondant);

      // 5. Cloisonnement ACL strict de la Passerelle Edge Messagerie
      await expect(
        passerelleMessagerie.publier(
          aliceId,
          AMQP_EXCHANGES.COMMANDES,
          'ac.AC-N3-DSI-MESSAGERIE',
          { demandeId: 'hack' },
          {
            headers: {
              echange_id: 'e1',
              type_message: 'MSG_TEXTE',
              niveau_securite: 'NON_SECURISE'
            }
          }
        )
      ).rejects.toThrow(ErreurAclEdge);

      await expect(
        passerelleMessagerie.publier(
          aliceId,
          AMQP_EXCHANGES.PUBLICATIONS,
          'lcr.AC-N3-DSI-MESSAGERIE',
          { lcr: {} },
          {
            headers: {
              echange_id: 'e1',
              type_message: 'MSG_TEXTE',
              niveau_securite: 'NON_SECURISE'
            }
          }
        )
      ).rejects.toThrow(ErreurAclEdge);

      await expect(
        passerelleMessagerie.consommer(
          aliceId,
          'q.pki.ac.AC-N3-DSI-MESSAGERIE.demandes',
          () => {}
        )
      ).rejects.toThrow(ErreurAclEdge);

      await expect(
        passerelleMessagerie.consommer(aliceId, 'q.pki.publication.flux', () => {})
      ).rejects.toThrow(ErreurAclEdge);

      await expect(
        passerelleMessagerie.consommer(aliceId, `q.chat.inbox.${bobId}`, () => {})
      ).rejects.toThrow(ErreurAclEdge);

      await expect(
        transportChatAlice.abonnerBoiteReception(bobId, () => {})
      ).rejects.toThrow(ErreurAclEdge);

      await expect(
        passerelleMessagerie.publier(
          aliceId,
          AMQP_EXCHANGES.CHAT_MESSAGES,
          `inbox.${bobId}`,
          { texte: 'sans en-têtes' },
          { headers: { echange_id: 'e1' } }
        )
      ).rejects.toThrow(ErreurAclEdge);

      await expect(
        passerelleMessagerie.publier(
          aliceId,
          AMQP_EXCHANGES.CHAT_MESSAGES,
          `inbox.${bobId}`,
          { emetteurId: bobId },
          {
            headers: {
              echange_id: 'e1',
              type_message: 'MSG_TEXTE',
              niveau_securite: 'NON_SECURISE',
              emetteur_id: bobId
            }
          }
        )
      ).rejects.toThrow(ErreurAclEdge);

      await alice.arreter();
      await bob.arreter();
    } finally {
      await plateforme.arreter();
    }
  });
});
