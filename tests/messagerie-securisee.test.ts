import { describe, it, expect } from 'vitest';
import {
  AMQP_EXCHANGES,
  AutoriteEnregistrement,
  InMemoryAmqpBroker,
  DirectAmqpChatTransport,
  CorrespondantClient,
  UtilisateurIcpClient,
  ServicePublication,
  AutoriteValidation,
  amorcerHierarchieAc,
  canonicalJson,
  decryptHybridMessage,
  encryptHybridMessage,
  generateRsaKeyPair,
  signMessageText,
  ErreurSecuriteEchange,
  ErreurSessionFermee,
  ErreurSequenceMessage,
  ErreurValidationCorrespondant,
  chatInboxQueue,
  chatRoutingKey
} from '../src/index.js';
import type {
  AmqpMessage,
  Certificat,
  DemandeCertificationReponse,
  MessageChatPayload,
  RestRequest,
  RestResponse,
  UsageCle
} from '../src/index.js';

function creerTransportRestPki(
  annuaire: ServicePublication,
  av: AutoriteValidation
) {
  return async (req: RestRequest): Promise<RestResponse> => {
    if (req.path.startsWith('/annuaire') || req.path.startsWith('/api/v1/annuaire')) {
      return annuaire.handleRestRequest(req);
    }
    if (req.path.startsWith('/av/') || req.path.startsWith('/api/v1/av/')) {
      return av.handleRestRequest(req);
    }
    return {
      status: 404,
      body: {
        code: 'ROUTE_INTROUVABLE',
        message: `Route inconnue: ${req.path}`,
        horodatage: new Date().toISOString(),
        chemin: req.path
      }
    };
  };
}

describe('Slice 1 — Transport AMQP ex.chat.messages, mode NON_SECURISE et clôture FIN_MSG', () => {
  it('déclare ex.chat.messages (direct, durable), q.chat.inbox.<id>, transporte INIT_ECHANGE -> MSG_TEXTE -> FIN_MSG avec propriétés AMQP standards et rejette tout envoi/réception après FIN_MSG', async () => {
    const broker = new InMemoryAmqpBroker();
    const annuaire = new ServicePublication(broker);
    await annuaire.ready();
    const av = new AutoriteValidation({ nature: 'messagerie', broker });
    await av.ready();
    const hierarchie = await amorcerHierarchieAc(broker);

    const utilisateurIcp = new UtilisateurIcpClient({
      transport: creerTransportRestPki(annuaire, av),
      certificatAcRacine: hierarchie.racine.getCertificatAc()
    });

    const chatTransport = new DirectAmqpChatTransport(broker);

    const messagesSurFil: AmqpMessage<MessageChatPayload>[] = [];
    const aliceId = 'alice.martin@dsi.organisation.fr';
    const bobId = 'bob.dupont@dsi.organisation.fr';

    const alice = new CorrespondantClient({
      correspondantId: aliceId,
      transport: chatTransport,
      utilisateurIcp
    });
    const bob = new CorrespondantClient({
      correspondantId: bobId,
      transport: chatTransport,
      utilisateurIcp
    });

    await alice.ready();
    await bob.ready();

    // Vérification topologie AMQP 0-9-1
    const exchangeChat = broker.listExchanges().find((e) => e.name === AMQP_EXCHANGES.CHAT_MESSAGES);
    expect(exchangeChat).toEqual({
      name: 'ex.chat.messages',
      type: 'direct',
      durable: true
    });

    const queues = broker.listQueues();
    expect(queues.find((q) => q.name === chatInboxQueue(aliceId))?.durable).toBe(true);
    expect(queues.find((q) => q.name === chatInboxQueue(bobId))?.durable).toBe(true);

    const bindings = broker.listBindings();
    expect(bindings).toContainEqual({
      queue: chatInboxQueue(bobId),
      exchange: 'ex.chat.messages',
      routingKey: chatRoutingKey(bobId)
    });

    // Espion non intrusif sur une file tap liée à inbox.bob pour inspecter les propriétés AMQP sur le fil
    broker.declareQueue('q.test.wiretap.bob', { durable: false });
    broker.bindQueue('q.test.wiretap.bob', AMQP_EXCHANGES.CHAT_MESSAGES, chatRoutingKey(bobId));
    await broker.consume<MessageChatPayload>('q.test.wiretap.bob', (msg) => {
      messagesSurFil.push(msg);
    });

    // 1. Alice ouvre l'échange en mode NON_SECURISE
    const ouverture = await alice.ouvrirEchange(bobId, 'NON_SECURISE', 'Bonjour Bob !');
    expect(ouverture.typeMessage).toBe('INIT_ECHANGE');
    expect(ouverture.numeroSequence).toBe(1);
    expect(ouverture.sessionFermee).toBe(false);

    // Vérification propriétés AMQP standards
    expect(messagesSurFil).toHaveLength(1);
    const wireInit = messagesSurFil[0]!;
    expect(wireInit.properties.content_type).toBe('application/json');
    expect(wireInit.properties.delivery_mode).toBe(2);
    expect(wireInit.properties.correlation_id).toBe(ouverture.echangeId);
    expect(wireInit.properties.type).toBe('INIT_ECHANGE');
    expect(typeof wireInit.properties.message_id).toBe('string');
    expect(typeof wireInit.properties.timestamp).toBe('string');
    expect(wireInit.properties.headers).toMatchObject({
      echange_id: ouverture.echangeId,
      type_message: 'INIT_ECHANGE',
      niveau_securite: 'NON_SECURISE',
      emetteur_id: aliceId
    });

    // 2. Bob répond sur le même échange
    const repBob = await bob.envoyerMessage(ouverture.echangeId, 'Salut Alice, bien reçu.');
    expect(repBob.typeMessage).toBe('MSG_TEXTE');
    expect(repBob.numeroSequence).toBe(1);

    // 3. Alice envoie un message contenant uniquement FIN_MSG -> clôture définitive
    const cloture = await alice.envoyerMessage(ouverture.echangeId, 'FIN_MSG');
    expect(cloture.typeMessage).toBe('FIN_MSG');
    expect(cloture.sessionFermee).toBe(true);
    expect(messagesSurFil[1]!.properties.type).toBe('FIN_MSG');

    expect(bob.getMessagesRecus().map((m) => m.contenu)).toEqual([
      'Bonjour Bob !',
      'FIN_MSG'
    ]);
    expect(alice.getMessagesRecus().map((m) => m.contenu)).toEqual([
      'Salut Alice, bien reçu.'
    ]);
    expect(alice.getSession(ouverture.echangeId)?.statut).toBe('FERMEE');
    expect(bob.getSession(ouverture.echangeId)?.statut).toBe('FERMEE');

    // 4. Tout envoi ultérieur côté Alice ou Bob échoue définitivement
    await expect(
      alice.envoyerMessage(ouverture.echangeId, 'Après FIN_MSG')
    ).rejects.toThrow(ErreurSessionFermee);
    await expect(
      bob.envoyerMessage(ouverture.echangeId, 'Réponse tardive')
    ).rejects.toThrow(ErreurSessionFermee);
  });
});

async function monterInfrastructureMessagerie(horloge?: () => Date) {
  const broker = new InMemoryAmqpBroker();
  const annuaire = new ServicePublication(broker, { horloge });
  await annuaire.ready();
  const av = new AutoriteValidation({ nature: 'messagerie', broker, horloge });
  await av.ready();
  const hierarchie = await amorcerHierarchieAc(broker, { horloge });

  const aliceId = 'alice.martin@dsi.organisation.fr';
  const bobId = 'bob.dupont@dsi.organisation.fr';
  const charlieId = 'charlie.bernard@dsi.organisation.fr';

  const ae = new AutoriteEnregistrement({
    nature: 'messagerie',
    broker,
    servicePublication: annuaire,
    horloge,
    entites: [
      {
        nomEntite: aliceId,
        motDePasse: 'AlicePass#2026',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE'
      },
      {
        nomEntite: bobId,
        motDePasse: 'BobPass#2026',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE'
      },
      {
        nomEntite: charlieId,
        motDePasse: 'CharliePass#2026',
        droitSignature: true,
        droitChiffrement: true,
        droitDemandeRevocation: true,
        acRattachementId: 'AC-N3-DSI-MESSAGERIE'
      }
    ]
  });
  await ae.ready();

  const utilisateurIcp = new UtilisateurIcpClient({
    transport: creerTransportRestPki(annuaire, av),
    certificatAcRacine: hierarchie.racine.getCertificatAc(),
    horloge
  });

  const chatTransport = new DirectAmqpChatTransport(broker);

  async function enroller(
    nomEntite: string,
    motDePasse: string,
    usage: UsageCle
  ): Promise<{ certificat: Certificat; clePrivee: string }> {
    const keys = generateRsaKeyPair();
    const rep = await ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-certification',
      body: {
        nomEntite,
        motDePasse,
        usage,
        clePublique: keys.publicKeyBase64
      }
    });
    if (rep.status !== 201) {
      throw new Error(`Enrôlement échoué pour ${nomEntite}: HTTP ${rep.status}`);
    }
    return {
      certificat: (rep.body as DemandeCertificationReponse).certificat!,
      clePrivee: keys.privateKeyPem
    };
  }

  return {
    broker,
    annuaire,
    av,
    ae,
    hierarchie,
    utilisateurIcp,
    chatTransport,
    aliceId,
    bobId,
    charlieId,
    enroller
  };
}

describe('Slice 2 — Mode SIGNE (RSA-SHA256), validation 4 étapes et rejet des altérations', () => {
  it('valide les certificats en 4 étapes, signe les messages (combiné et distincts), clôt par FIN_MSG et rejette toute altération du contenu ou de la signature', async () => {
    const infra = await monterInfrastructureMessagerie();

    // Alice a un certificat combiné SIGNATURE_ET_CHIFFREMENT ; Bob a deux certificats distincts SIGNATURE + CHIFFREMENT
    const aliceCert = await infra.enroller(
      infra.aliceId,
      'AlicePass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );
    const bobSign = await infra.enroller(infra.bobId, 'BobPass#2026', 'SIGNATURE');
    const bobEnc = await infra.enroller(infra.bobId, 'BobPass#2026', 'CHIFFREMENT');

    const alice = new CorrespondantClient({
      correspondantId: infra.aliceId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: aliceCert.certificat,
      clePrivee: aliceCert.clePrivee
    });
    const bob = new CorrespondantClient({
      correspondantId: infra.bobId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificatSignature: bobSign.certificat,
      clePriveeSignature: bobSign.clePrivee,
      certificatChiffrement: bobEnc.certificat,
      clePriveeChiffrement: bobEnc.clePrivee
    });

    await alice.ready();
    await bob.ready();

    const wireMessages: AmqpMessage<MessageChatPayload>[] = [];
    infra.broker.declareQueue('q.test.wiretap.signe', { durable: false });
    infra.broker.bindQueue(
      'q.test.wiretap.signe',
      AMQP_EXCHANGES.CHAT_MESSAGES,
      chatRoutingKey(infra.bobId)
    );
    await infra.broker.consume<MessageChatPayload>('q.test.wiretap.signe', (msg) => {
      wireMessages.push(msg);
    });

    const init = await alice.ouvrirEchange(infra.bobId, 'SIGNE', 'Message signé initial');
    expect(wireMessages[0]!.payload.signature).toBeTypeOf('string');
    expect(wireMessages[0]!.payload.numeroSerieCertificatSignature).toBe(
      aliceCert.certificat.numeroSerie
    );

    await bob.envoyerMessage(init.echangeId, 'Réponse signée par Bob');

    // Tentative d'injection sur le fil d'un message dont le contenu a été altéré
    const msgValide = wireMessages[0]!;
    const payloadContenuAltere: MessageChatPayload = {
      ...msgValide.payload,
      numeroSequence: 2,
      typeMessage: 'MSG_TEXTE',
      contenu: 'Montant modifié à 99999 EUR'
    };
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        payloadContenuAltere,
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSecuriteEchange);

    // Tentative d'injection avec signature corrompue
    const payloadSignatureAlteree: MessageChatPayload = {
      ...msgValide.payload,
      numeroSequence: 2,
      typeMessage: 'MSG_TEXTE',
      signature: 'AAAA' + (msgValide.payload.signature ?? '').slice(4)
    };
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        payloadSignatureAlteree,
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSecuriteEchange);

    // La session est toujours active et seuls les messages légitimes ont été délivrés
    expect(bob.getMessagesRecus().map((m) => m.contenu)).toEqual(['Message signé initial']);
    expect(bob.getErreurs()).toHaveLength(2);

    // Clôture légitime signée par FIN_MSG
    await alice.envoyerMessage(init.echangeId, 'FIN_MSG');
    expect(bob.getMessagesRecus().map((m) => m.contenu)).toEqual([
      'Message signé initial',
      'FIN_MSG'
    ]);
    expect(bob.getSession(init.echangeId)?.statut).toBe('FERMEE');
  });
});

describe('Slice 3 — Modes CHIFFRE et SIGNE_ET_CHIFFRE (RSA-OAEP + AES-256-GCM), inspection sur le fil et intégrité', () => {
  it('chiffre efficacement en mode CHIFFRE (illisible sur le fil AMQP sans clé privée du récepteur) et clôt par FIN_MSG chiffré', async () => {
    const infra = await monterInfrastructureMessagerie();

    // Alice a deux certificats distincts ; Bob a un certificat combiné
    const aliceSign = await infra.enroller(infra.aliceId, 'AlicePass#2026', 'SIGNATURE');
    const aliceEnc = await infra.enroller(infra.aliceId, 'AlicePass#2026', 'CHIFFREMENT');
    const bobCombined = await infra.enroller(
      infra.bobId,
      'BobPass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );
    const attaquantKeys = generateRsaKeyPair();

    const alice = new CorrespondantClient({
      correspondantId: infra.aliceId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificatSignature: aliceSign.certificat,
      clePriveeSignature: aliceSign.clePrivee,
      certificatChiffrement: aliceEnc.certificat,
      clePriveeChiffrement: aliceEnc.clePrivee
    });
    const bob = new CorrespondantClient({
      correspondantId: infra.bobId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: bobCombined.certificat,
      clePrivee: bobCombined.clePrivee
    });
    await alice.ready();
    await bob.ready();

    const wireBob: AmqpMessage<MessageChatPayload>[] = [];
    infra.broker.declareQueue('q.test.wiretap.chiffre', { durable: false });
    infra.broker.bindQueue(
      'q.test.wiretap.chiffre',
      AMQP_EXCHANGES.CHAT_MESSAGES,
      chatRoutingKey(infra.bobId)
    );
    await infra.broker.consume<MessageChatPayload>('q.test.wiretap.chiffre', (msg) => {
      wireBob.push(msg);
    });

    const secretInitial = 'Code secret alpha-98765';
    const init = await alice.ouvrirEchange(infra.bobId, 'CHIFFRE', secretInitial);

    expect(wireBob).toHaveLength(1);
    const rawWire = wireBob[0]!.rawBody;
    expect(rawWire).not.toContain(secretInitial);
    expect(wireBob[0]!.payload.contenu).toBeUndefined();
    expect(wireBob[0]!.payload.contenuChiffre).toBeTypeOf('string');
    expect(wireBob[0]!.payload.numeroSerieCertificatChiffrement).toBe(
      bobCombined.certificat.numeroSerie
    );

    // Impossible de déchiffrer avec une autre clé privée (attaquant ou Alice)
    expect(() =>
      decryptHybridMessage(wireBob[0]!.payload.contenuChiffre!, attaquantKeys.privateKeyPem)
    ).toThrow();
    expect(() =>
      decryptHybridMessage(wireBob[0]!.payload.contenuChiffre!, aliceEnc.clePrivee)
    ).toThrow();

    // Seul Bob déchiffre correctement
    expect(bob.getMessagesRecus().map((m) => m.contenu)).toEqual([secretInitial]);

    // Réponse chiffrée de Bob vers Alice (chiffrée avec aliceEnc, pas aliceSign)
    await bob.envoyerMessage(init.echangeId, 'Bien reçu en secret');
    expect(alice.getMessagesRecus().map((m) => m.contenu)).toEqual(['Bien reçu en secret']);

    // Clôture par FIN_MSG chiffré (le code FIN_MSG ne doit pas apparaître en clair dans contenuChiffre)
    await alice.envoyerMessage(init.echangeId, 'FIN_MSG');
    expect(wireBob[1]!.payload.contenu).toBeUndefined();
    expect(
      decryptHybridMessage(wireBob[1]!.payload.contenuChiffre!, bobCombined.clePrivee)
    ).toBe('FIN_MSG');
    expect(bob.getSession(init.echangeId)?.statut).toBe('FERMEE');
  });

  it('signe puis chiffre en mode SIGNE_ET_CHIFFRE, déchiffre puis vérifie la signature, et rejette tout chiffrement corrompu ou signature interne falsifiée', async () => {
    const infra = await monterInfrastructureMessagerie();

    const aliceCert = await infra.enroller(
      infra.aliceId,
      'AlicePass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );
    const bobSign = await infra.enroller(infra.bobId, 'BobPass#2026', 'SIGNATURE');
    const bobEnc = await infra.enroller(infra.bobId, 'BobPass#2026', 'CHIFFREMENT');
    const charlieCert = await infra.enroller(
      infra.charlieId,
      'CharliePass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );

    const alice = new CorrespondantClient({
      correspondantId: infra.aliceId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: aliceCert.certificat,
      clePrivee: aliceCert.clePrivee
    });
    const bob = new CorrespondantClient({
      correspondantId: infra.bobId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificatSignature: bobSign.certificat,
      clePriveeSignature: bobSign.clePrivee,
      certificatChiffrement: bobEnc.certificat,
      clePriveeChiffrement: bobEnc.clePrivee
    });
    await alice.ready();
    await bob.ready();

    const wireBob: AmqpMessage<MessageChatPayload>[] = [];
    infra.broker.declareQueue('q.test.wiretap.sc', { durable: false });
    infra.broker.bindQueue(
      'q.test.wiretap.sc',
      AMQP_EXCHANGES.CHAT_MESSAGES,
      chatRoutingKey(infra.bobId)
    );
    await infra.broker.consume<MessageChatPayload>('q.test.wiretap.sc', (msg) => {
      wireBob.push(msg);
    });

    const texteConfidentiel = 'Ordre confidentiel et signé #42';
    const init = await alice.ouvrirEchange(
      infra.bobId,
      'SIGNE_ET_CHIFFRE',
      texteConfidentiel
    );

    // Ni le texte clair ni la signature en clair ne fuient sur le fil AMQP
    expect(wireBob[0]!.rawBody).not.toContain(texteConfidentiel);
    expect(wireBob[0]!.payload.contenu).toBeUndefined();
    expect(wireBob[0]!.payload.signature).toBeUndefined();
    expect(wireBob[0]!.payload.contenuChiffre).toBeTypeOf('string');
    expect(bob.getMessagesRecus().map((m) => m.contenu)).toEqual([texteConfidentiel]);

    // 1. Altération du texte chiffré sur le fil -> rejet DECHIFFREMENT_IMPOSSIBLE
    const enveloppeChiffree = JSON.parse(wireBob[0]!.payload.contenuChiffre!) as {
      alg: string;
      encryptedKey: string;
      iv: string;
      authTag: string;
      ciphertext: string;
    };
    const payloadChiffreAltere: MessageChatPayload = {
      ...wireBob[0]!.payload,
      numeroSequence: 2,
      typeMessage: 'MSG_TEXTE',
      contenuChiffre: JSON.stringify({
        ...enveloppeChiffree,
        ciphertext: Buffer.from('corrupted-ciphertext').toString('base64')
      })
    };
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        payloadChiffreAltere,
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE_ET_CHIFFRE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSecuriteEchange);

    // 2. Message valablement chiffré pour Bob, mais signé par Charlie en usurpant l'identité d'Alice -> rejet après déchiffrement
    const horodatageFaux = new Date().toISOString();
    const fauxTexte = 'Faux ordre signé par Charlie';
    const fausseSig = signMessageText(
      canonicalJson({
        echangeId: init.echangeId,
        numeroSequence: 2,
        typeMessage: 'MSG_TEXTE',
        niveauSecurite: 'SIGNE_ET_CHIFFRE',
        emetteurId: infra.aliceId,
        destinataireId: infra.bobId,
        horodatage: horodatageFaux,
        contenu: fauxTexte
      }),
      charlieCert.clePrivee
    );
    const fauxContenuChiffre = encryptHybridMessage(
      JSON.stringify({
        contenu: fauxTexte,
        signature: fausseSig,
        numeroSerieCertificatSignature: aliceCert.certificat.numeroSerie
      }),
      bobEnc.certificat.clePublique
    );
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        {
          echangeId: init.echangeId,
          numeroSequence: 2,
          typeMessage: 'MSG_TEXTE',
          niveauSecurite: 'SIGNE_ET_CHIFFRE',
          emetteurId: infra.aliceId,
          destinataireId: infra.bobId,
          horodatage: horodatageFaux,
          contenuChiffre: fauxContenuChiffre,
          numeroSerieCertificatChiffrement: bobEnc.certificat.numeroSerie
        },
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE_ET_CHIFFRE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSecuriteEchange);

    // Bob répond puis clôt proprement avec FIN_MSG
    await bob.envoyerMessage(init.echangeId, 'Accusé signé et chiffré');
    await bob.cloreEchange(init.echangeId);
    expect(alice.getMessagesRecus().map((m) => m.contenu)).toEqual([
      'Accusé signé et chiffré',
      'FIN_MSG'
    ]);
    expect(alice.getSession(init.echangeId)?.statut).toBe('FERMEE');
    expect(bob.getSession(init.echangeId)?.statut).toBe('FERMEE');
  });
});

describe('Slice 4 — Rejet immédiat à l’ouverture si le Certificat d’un Correspondant est expiré, révoqué, suspendu, inconnu ou d’usage incompatible', () => {
  it('rejette l’ouverture d’un Échange sécurisé lorsque le certificat du destinataire ou de l’initiateur est révoqué, suspendu, inconnu, expiré ou d’usage incompatible', async () => {
    let maintenant = new Date('2026-06-01T10:00:00Z');
    const infra = await monterInfrastructureMessagerie(() => maintenant);

    const aliceCert = await infra.enroller(
      infra.aliceId,
      'AlicePass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );
    const bobCert = await infra.enroller(
      infra.bobId,
      'BobPass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );
    const charlieSignOnly = await infra.enroller(
      infra.charlieId,
      'CharliePass#2026',
      'SIGNATURE'
    );

    const alice = new CorrespondantClient({
      correspondantId: infra.aliceId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: aliceCert.certificat,
      clePrivee: aliceCert.clePrivee,
      horloge: () => maintenant
    });
    await alice.ready();

    // 1. Destinataire inconnu (aucun certificat dans l'annuaire)
    await expect(
      alice.ouvrirEchange('inconnu@dsi.organisation.fr', 'SIGNE', 'Test inconnu')
    ).rejects.toThrow(ErreurValidationCorrespondant);

    // 2. Usage incompatible côté destinataire (Charlie n'a qu'un cert SIGNATURE, Alice veut CHIFFRE)
    await expect(
      alice.ouvrirEchange(infra.charlieId, 'CHIFFRE', 'Test usage incompatible')
    ).rejects.toThrow(ErreurValidationCorrespondant);

    // 3. Usage incompatible côté initiateur (Charlie tente CHIFFRE avec son cert SIGNATURE)
    const charlie = new CorrespondantClient({
      correspondantId: infra.charlieId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: charlieSignOnly.certificat,
      clePrivee: charlieSignOnly.clePrivee,
      horloge: () => maintenant
    });
    await charlie.ready();
    await expect(
      charlie.ouvrirEchange(infra.bobId, 'CHIFFRE', 'Test propre usage incompatible')
    ).rejects.toThrow(ErreurValidationCorrespondant);

    // 4. Suspension de Bob -> ouverture rejetée immédiatement
    const suspRep = await infra.ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: infra.bobId,
        motDePasse: 'BobPass#2026',
        numeroSerieCertificat: bobCert.certificat.numeroSerie,
        action: 'SUSPENSION',
        motif: 'SUSPENSION_TEMPORAIRE'
      }
    });
    expect(suspRep.status).toBe(200);

    await expect(
      alice.ouvrirEchange(infra.bobId, 'SIGNE_ET_CHIFFRE', 'Vers Bob suspendu')
    ).rejects.toThrow(ErreurValidationCorrespondant);

    // Réactivation de Bob -> fonctionne à nouveau
    const reactRep = await infra.ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: infra.bobId,
        motDePasse: 'BobPass#2026',
        numeroSerieCertificat: bobCert.certificat.numeroSerie,
        action: 'REACTIVATION'
      }
    });
    expect(reactRep.status).toBe(200);

    // 5. Révocation définitive de Bob -> ouverture rejetée immédiatement
    const revRep = await infra.ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: infra.bobId,
        motDePasse: 'BobPass#2026',
        numeroSerieCertificat: bobCert.certificat.numeroSerie,
        action: 'REVOCATION',
        motif: 'COMPROMISSION_CLE_PRIVEE'
      }
    });
    expect(revRep.status).toBe(200);

    await expect(
      alice.ouvrirEchange(infra.bobId, 'CHIFFRE', 'Vers Bob révoqué')
    ).rejects.toThrow(ErreurValidationCorrespondant);

    // 6. Expiration temporelle d'Alice (horloge avancée de 2 ans) -> rejet immédiat même vers un tiers valide
    maintenant = new Date('2028-06-01T10:00:00Z');
    await expect(
      alice.ouvrirEchange(infra.charlieId, 'SIGNE', 'Alice expirée')
    ).rejects.toThrow(ErreurValidationCorrespondant);
  });
});

describe('Slice 5 — Invariants de session : immuabilité du niveau, séquence monotone, révocation/suspension en cours de session et post-FIN_MSG', () => {
  it('rejette toute rétrogradation/changement de niveau de sécurité, séquence non monotone ou rejeu, et tout message reçu après FIN_MSG', async () => {
    const infra = await monterInfrastructureMessagerie();
    const aliceCert = await infra.enroller(
      infra.aliceId,
      'AlicePass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );
    const bobCert = await infra.enroller(
      infra.bobId,
      'BobPass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );

    const alice = new CorrespondantClient({
      correspondantId: infra.aliceId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: aliceCert.certificat,
      clePrivee: aliceCert.clePrivee
    });
    const bob = new CorrespondantClient({
      correspondantId: infra.bobId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: bobCert.certificat,
      clePrivee: bobCert.clePrivee
    });
    await alice.ready();
    await bob.ready();

    const wireBob: AmqpMessage<MessageChatPayload>[] = [];
    infra.broker.declareQueue('q.test.wiretap.invariants', { durable: false });
    infra.broker.bindQueue(
      'q.test.wiretap.invariants',
      AMQP_EXCHANGES.CHAT_MESSAGES,
      chatRoutingKey(infra.bobId)
    );
    await infra.broker.consume<MessageChatPayload>('q.test.wiretap.invariants', (msg) => {
      wireBob.push(msg);
    });

    const init = await alice.ouvrirEchange(
      infra.bobId,
      'SIGNE_ET_CHIFFRE',
      'Ouverture verrouillée'
    );
    const msg2 = await alice.envoyerMessage(init.echangeId, 'Message #2 légitime');
    expect(msg2.numeroSequence).toBe(2);

    // 1. Tentative côté client de rétrograder ou changer le niveau de sécurité
    await expect(
      alice.envoyerMessage(init.echangeId, 'Tentative downgrade', {
        niveauSecurite: 'NON_SECURISE'
      })
    ).rejects.toThrow(ErreurSecuriteEchange);

    await expect(
      bob.envoyerMessage(init.echangeId, 'Tentative changement vers SIGNE', {
        niveauSecurite: 'SIGNE'
      })
    ).rejects.toThrow(ErreurSecuriteEchange);

    // 2. Tentative sur le fil AMQP d'injecter un message NON_SECURISE ou SIGNE dans une session SIGNE_ET_CHIFFRE
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        {
          echangeId: init.echangeId,
          numeroSequence: 3,
          typeMessage: 'MSG_TEXTE',
          niveauSecurite: 'NON_SECURISE',
          emetteurId: infra.aliceId,
          destinataireId: infra.bobId,
          horodatage: new Date().toISOString(),
          contenu: 'Downgrade injecté'
        },
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'NON_SECURISE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSecuriteEchange);

    // 3. Rejeu du message #2 (numéro de séquence non monotone : 2 <= 2, puis 1 <= 2)
    const replayPayload = wireBob[1]!.payload;
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        replayPayload,
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE_ET_CHIFFRE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSequenceMessage);

    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        { ...wireBob[0]!.payload, typeMessage: 'MSG_TEXTE' },
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE_ET_CHIFFRE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSequenceMessage);

    // 4. Clôture par FIN_MSG puis rejet de tout message reçu ultérieurement sur cet echangeId
    await alice.cloreEchange(init.echangeId);
    expect(bob.getSession(init.echangeId)?.statut).toBe('FERMEE');

    const apresClotureChiffre = encryptHybridMessage(
      JSON.stringify({
        contenu: 'Tentative après FIN_MSG',
        signature: 'dummy',
        numeroSerieCertificatSignature: aliceCert.certificat.numeroSerie
      }),
      bobCert.certificat.clePublique
    );
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        {
          echangeId: init.echangeId,
          numeroSequence: 4,
          typeMessage: 'MSG_TEXTE',
          niveauSecurite: 'SIGNE_ET_CHIFFRE',
          emetteurId: infra.aliceId,
          destinataireId: infra.bobId,
          horodatage: new Date().toISOString(),
          contenuChiffre: apresClotureChiffre,
          numeroSerieCertificatChiffrement: bobCert.certificat.numeroSerie
        },
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE_ET_CHIFFRE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurSessionFermee);
  });

  it('contrôle dynamiquement le statut auprès de l’AV pendant un Échange actif et rejette immédiatement après suspension ou révocation en cours de session', async () => {
    const infra = await monterInfrastructureMessagerie();
    const aliceCert = await infra.enroller(
      infra.aliceId,
      'AlicePass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );
    const bobCert = await infra.enroller(
      infra.bobId,
      'BobPass#2026',
      'SIGNATURE_ET_CHIFFREMENT'
    );

    const alice = new CorrespondantClient({
      correspondantId: infra.aliceId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: aliceCert.certificat,
      clePrivee: aliceCert.clePrivee
    });
    const bob = new CorrespondantClient({
      correspondantId: infra.bobId,
      transport: infra.chatTransport,
      utilisateurIcp: infra.utilisateurIcp,
      certificat: bobCert.certificat,
      clePrivee: bobCert.clePrivee
    });
    await alice.ready();
    await bob.ready();

    const init = await alice.ouvrirEchange(
      infra.bobId,
      'SIGNE',
      'Session active avant suspension'
    );

    // Suspension d'Alice en cours d'échange
    const suspAlice = await infra.ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: infra.aliceId,
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: aliceCert.certificat.numeroSerie,
        action: 'SUSPENSION',
        motif: 'SUSPENSION_TEMPORAIRE'
      }
    });
    expect(suspAlice.status).toBe(200);

    // Ni Alice ni Bob ne peuvent poursuivre tant qu'Alice est suspendue
    await expect(
      alice.envoyerMessage(init.echangeId, 'Envoi bloqué pendant suspension')
    ).rejects.toThrow(ErreurValidationCorrespondant);
    await expect(
      bob.envoyerMessage(init.echangeId, 'Réponse bloquée car Alice suspendue')
    ).rejects.toThrow(ErreurValidationCorrespondant);

    // Et même un message forgé/pré-signé d'Alice injecté directement sur AMQP est rejeté par Bob via contrôle AV
    const horodatage = new Date().toISOString();
    const texte = 'Message pré-signé pendant suspension';
    const sig = signMessageText(
      canonicalJson({
        echangeId: init.echangeId,
        numeroSequence: 2,
        typeMessage: 'MSG_TEXTE',
        niveauSecurite: 'SIGNE',
        emetteurId: infra.aliceId,
        destinataireId: infra.bobId,
        horodatage,
        contenu: texte
      }),
      aliceCert.clePrivee
    );
    await expect(
      infra.broker.publish(
        AMQP_EXCHANGES.CHAT_MESSAGES,
        chatRoutingKey(infra.bobId),
        {
          echangeId: init.echangeId,
          numeroSequence: 2,
          typeMessage: 'MSG_TEXTE',
          niveauSecurite: 'SIGNE',
          emetteurId: infra.aliceId,
          destinataireId: infra.bobId,
          horodatage,
          contenu: texte,
          signature: sig,
          numeroSerieCertificatSignature: aliceCert.certificat.numeroSerie
        },
        {
          content_type: 'application/json',
          delivery_mode: 2,
          correlation_id: init.echangeId,
          type: 'MSG_TEXTE',
          headers: {
            echange_id: init.echangeId,
            type_message: 'MSG_TEXTE',
            niveau_securite: 'SIGNE',
            emetteur_id: infra.aliceId
          }
        }
      )
    ).rejects.toThrow(ErreurValidationCorrespondant);

    // Réactivation d'Alice -> l'échange actif reprend normalement
    const reactAlice = await infra.ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: infra.aliceId,
        motDePasse: 'AlicePass#2026',
        numeroSerieCertificat: aliceCert.certificat.numeroSerie,
        action: 'REACTIVATION'
      }
    });
    expect(reactAlice.status).toBe(200);

    await alice.envoyerMessage(init.echangeId, 'Reprise après réactivation');
    expect(bob.getMessagesRecus().map((m) => m.contenu)).toEqual([
      'Session active avant suspension',
      'Reprise après réactivation'
    ]);

    // Révocation définitive de Bob en cours d'échange -> blocage immédiat et irréversible
    const revBob = await infra.ae.handleRestRequest({
      method: 'POST',
      path: '/ae/messagerie/demandes-revocation',
      body: {
        nomEntite: infra.bobId,
        motDePasse: 'BobPass#2026',
        numeroSerieCertificat: bobCert.certificat.numeroSerie,
        action: 'REVOCATION',
        motif: 'COMPROMISSION_CLE_PRIVEE'
      }
    });
    expect(revBob.status).toBe(200);

    await expect(
      alice.envoyerMessage(init.echangeId, 'Envoi après révocation de Bob')
    ).rejects.toThrow(ErreurValidationCorrespondant);
    await expect(
      bob.cloreEchange(init.echangeId)
    ).rejects.toThrow(ErreurValidationCorrespondant);
  });
});
