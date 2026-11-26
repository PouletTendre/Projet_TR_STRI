import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  AMQP_EXCHANGES,
  AutoriteEnregistrement,
  AutoriteValidation,
  CorrespondantClient,
  ErreurAclEdge,
  UtilisateurIcpClient,
  creerPlateformeComplete,
  generateRsaKeyPair
} from './index.js';
import type {
  Certificat,
  DemandeCertificationReponse,
  DemandeRevocationReponse,
  StatutCertificatReponse
} from './index.js';

export async function executerDemo(): Promise<void> {
  const aliceId = 'alice.martin@dsi.organisation.fr';
  const bobId = 'bob.dupont@dsi.organisation.fr';
  const routeurId = 'routeur-coeur-01.infra.organisation.fr';

  console.log('=== Démonstration ICP Hiérarchique 3 Niveaux & Messagerie Sécurisée AMQP 0-9-1 ===');

  const plateforme = await creerPlateformeComplete({
    exigerTls: true,
    rateLimit: { limiteRequetes: 12, fenetreMs: 60_000 },
    entitesParNature: {
      messagerie: [
        {
          nomEntite: aliceId,
          motDePasse: 'AliceDemo2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        },
        {
          nomEntite: bobId,
          motDePasse: 'BobDemo2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-DSI-MESSAGERIE'
        }
      ],
      routeurs: [
        {
          nomEntite: routeurId,
          motDePasse: 'RouteurDemo2026!',
          droitSignature: true,
          droitChiffrement: true,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-INFRA-RESEAU'
        }
      ]
    }
  });

  const { apiGateway, passerelleMessagerie, serviceDiscovery, broker, annuaire } = plateforme;
  const https = { 'x-forwarded-proto': 'https' };

  try {
    // 1. Hiérarchie d'AC 3 niveaux & Configuration Server
    const repTopo = await apiGateway.handleRequest({
      method: 'GET',
      path: '/api/v1/config/topologie-ac',
      headers: https
    });
    const topo = repTopo.body as {
      acRacineId: string;
      profondeur: number;
      autorites: Array<{ acId: string; niveau: number }>;
    };
    const repAncre1 = await apiGateway.handleRequest({
      method: 'GET',
      path: '/api/v1/config/ancre-racine',
      headers: https
    });
    const ancreRacine = repAncre1.body as Certificat;
    const repAncre2 = await apiGateway.handleRequest({
      method: 'GET',
      path: '/api/v1/config/ancre-racine',
      headers: https
    });
    console.log(
      `[1/6] Hiérarchie AC amorcée : ${topo.autorites.length} autorités sur ${topo.profondeur} niveaux (racine=${topo.acRacineId}, cache ancre=${repAncre1.headers?.['X-Cache']}->${repAncre2.headers?.['X-Cache']}).`
    );

    // 2. Enrôlements nominaux (Alice, Bob) + enrôlement routeur (genererBicle: true)
    const bicleAlice = generateRsaKeyPair();
    const repAlice = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-certification',
      headers: https,
      body: {
        nomEntite: aliceId,
        motDePasse: 'AliceDemo2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: bicleAlice.publicKeyPem
      }
    });
    const certAlice = (repAlice.body as DemandeCertificationReponse).certificat!;

    const bicleBob = generateRsaKeyPair();
    const repBob = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-certification',
      headers: https,
      body: {
        nomEntite: bobId,
        motDePasse: 'BobDemo2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        clePublique: bicleBob.publicKeyPem
      }
    });
    const certBob = (repBob.body as DemandeCertificationReponse).certificat!;

    const repRouteur = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/routeurs/demandes-certification',
      headers: https,
      body: {
        nomEntite: routeurId,
        motDePasse: 'RouteurDemo2026!',
        usage: 'SIGNATURE_ET_CHIFFREMENT',
        genererBicle: true
      }
    });
    const bodyRouteur = repRouteur.body as DemandeCertificationReponse;
    console.log(
      `[2/6] Enrôlements réussis : Alice (${certAlice.numeroSerie}), Bob (${certBob.numeroSerie}), Routeur avec Biclé générée par l'AC (${bodyRouteur.certificat!.numeroSerie}, clé privée remise=${bodyRouteur.clePriveeGeneree !== null}).`
    );

    // 3. Validation en 4 étapes via UtilisateurIcpClient -> API Gateway
    const utilisateurIcp = new UtilisateurIcpClient({
      transport: apiGateway.transport(https),
      certificatAcRacine: ancreRacine
    });
    const validationBob = await utilisateurIcp.validerCertificat({
      numeroSerieCertificat: certBob.numeroSerie,
      natureRessource: 'messagerie',
      usageAttendu: 'CHIFFREMENT',
      sujetAttendu: bobId
    });
    if (!validationBob.valide) {
      throw new Error(`Échec inattendu de la validation en 4 étapes : ${validationBob.detailsEtapes.messageDiagnostic}`);
    }
    console.log(
      `[3/6] Validation en 4 étapes réussie pour ${bobId} (chemin=${validationBob.cheminCertification.length} certificats, statut=${validationBob.statutCourant}).`
    );

    // 4. Échange SIGNE_ET_CHIFFRE clos par FIN_MSG via Passerelle Edge Messagerie
    const alice = new CorrespondantClient({
      correspondantId: aliceId,
      natureRessource: 'messagerie',
      transport: passerelleMessagerie.creerTransportPourCorrespondant(aliceId),
      utilisateurIcp,
      certificat: certAlice,
      clePrivee: bicleAlice.privateKeyPem
    });
    const bob = new CorrespondantClient({
      correspondantId: bobId,
      natureRessource: 'messagerie',
      transport: passerelleMessagerie.creerTransportPourCorrespondant(bobId),
      utilisateurIcp,
      certificat: certBob,
      clePrivee: bicleBob.privateKeyPem
    });
    await alice.ready();
    await bob.ready();

    const ouverture = await alice.ouvrirEchange(
      bobId,
      'SIGNE_ET_CHIFFRE',
      'Bonjour Bob, canal SIGNE_ET_CHIFFRE ouvert.'
    );
    await bob.envoyerMessage(
      ouverture.echangeId,
      'Bien reçu Alice, message chiffré et signé.'
    );
    const cloture = await alice.cloreEchange(ouverture.echangeId);
    console.log(
      `[4/6] Échange ${ouverture.echangeId} (SIGNE_ET_CHIFFRE) mené et clos par ${cloture.typeMessage} (reçus Bob=${bob.getMessagesRecus().length}, Alice=${alice.getMessagesRecus().length}).`
    );

    await alice.arreter();
    await bob.arreter();

    // 5. Cycle Suspension -> Réactivation -> Révocation définitive -> 409
    const repSusp = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-revocation',
      headers: https,
      body: {
        nomEntite: aliceId,
        motDePasse: 'AliceDemo2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'SUSPENSION',
        motif: 'SUSPENSION_TEMPORAIRE'
      }
    });
    const etatSusp = (repSusp.body as DemandeRevocationReponse).nouvelEtatCertificat;

    const repReact = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-revocation',
      headers: https,
      body: {
        nomEntite: aliceId,
        motDePasse: 'AliceDemo2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REACTIVATION',
        motif: 'FIN_SUSPENSION'
      }
    });
    const etatReact = (repReact.body as DemandeRevocationReponse).nouvelEtatCertificat;

    const repRevoc = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-revocation',
      headers: https,
      body: {
        nomEntite: aliceId,
        motDePasse: 'AliceDemo2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REVOCATION',
        motif: 'COMPROMISSION_CLE_PRIVEE'
      }
    });
    const etatRevoc = (repRevoc.body as DemandeRevocationReponse).nouvelEtatCertificat;

    const rep409 = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/messagerie/demandes-revocation',
      headers: https,
      body: {
        nomEntite: aliceId,
        motDePasse: 'AliceDemo2026!',
        numeroSerieCertificat: certAlice.numeroSerie,
        action: 'REACTIVATION'
      }
    });
    const repAvFinal = await apiGateway.handleRequest({
      method: 'GET',
      path: `/av/messagerie/certificats/${certAlice.numeroSerie}/statut`,
      headers: https
    });
    console.log(
      `[5/6] Cycle d'invalidation Alice : ${etatSusp} -> ${etatReact} -> ${etatRevoc} (statut AV=${(repAvFinal.body as StatutCertificatReponse).statut}, réactivation post-révocation HTTP ${rep409.status}).`
    );

    // 6. Protections Edge (TLS 403, Rate-limiting 429, ajout à chaud, ACL Passerelle Messagerie)
    const repSansTls = await apiGateway.handleRequest({
      method: 'GET',
      path: '/config/topologie-ac'
    });

    const avIot = new AutoriteValidation({ nature: 'iot', broker });
    await avIot.ready();
    const aeIot = new AutoriteEnregistrement({
      nature: 'iot',
      broker,
      servicePublication: annuaire,
      entites: [
        {
          nomEntite: 'sonde-01@infra.organisation.fr',
          motDePasse: 'IotDemo!',
          droitSignature: true,
          droitChiffrement: false,
          droitDemandeRevocation: true,
          acRattachementId: 'AC-N3-INFRA-RESEAU'
        }
      ]
    });
    await aeIot.ready();
    serviceDiscovery.enregistrerNature('iot', { ae: aeIot, av: avIot });
    const repIot = await apiGateway.handleRequest({
      method: 'POST',
      path: '/api/v1/ae/iot/demandes-certification',
      headers: https,
      body: {
        nomEntite: 'sonde-01@infra.organisation.fr',
        motDePasse: 'IotDemo!',
        usage: 'SIGNATURE',
        genererBicle: true
      }
    });
    await aeIot.arreter();
    await avIot.arreter();

    let statusRateLimit = 0;
    for (let i = 0; i < 13; i += 1) {
      const rep = await apiGateway.handleRequest({
        method: 'POST',
        path: '/ae/routeurs/demandes-certification',
        headers: { ...https, 'x-client-id': 'demo-burst' },
        body: {}
      });
      statusRateLimit = rep.status;
    }

    let aclBloquee = false;
    try {
      await passerelleMessagerie.publier(
        aliceId,
        AMQP_EXCHANGES.COMMANDES,
        'ac.AC-N3-DSI-MESSAGERIE',
        {},
        {
          headers: {
            echange_id: 'demo',
            type_message: 'MSG_TEXTE',
            niveau_securite: 'NON_SECURISE'
          }
        }
      );
    } catch (err) {
      if (err instanceof ErreurAclEdge) {
        aclBloquee = true;
      }
    }

    console.log(
      `[6/6] Protections Edge vérifiées : TLS sans HTTPS=${repSansTls.status}, ajout à chaud nature "iot"=${repIot.status}, rate-limit rafale=${statusRateLimit}, ACL Passerelle Messagerie bloquée=${aclBloquee}.`
    );
    console.log('=== Démonstration terminée avec succès ===');
  } finally {
    await plateforme.arreter();
  }
}

const estExecutionDirecte =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (estExecutionDirecte) {
  executerDemo().catch((err) => {
    console.error('Échec de la démonstration :', err);
    process.exitCode = 1;
  });
}
