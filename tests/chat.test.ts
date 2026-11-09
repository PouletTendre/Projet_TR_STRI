import { describe, it, expect, vi } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';
import {
  CorrespondantClient,
  NiveauSecurite,
  TypeMessageChat,
  EtatEchange,
} from '../src/chat/index.js';

describe('Cycle de vie d\'un Échange de Messagerie Texte en mode NON_SECURISE (Ticket #6)', () => {
  it('should open an exchange in NON_SECURISE mode with INIT_ECHANGE and deliver to recipient inbox', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);

    const bobReceived: any[] = [];
    bob.onMessage((msg) => {
      bobReceived.push(msg);
    });

    const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Bonjour Bob !',
      niveauSecurite: 'NON_SECURISE',
    });

    expect(sessionAlice.echangeId).toBeDefined();
    expect(sessionAlice.niveauSecurite).toBe('NON_SECURISE');
    expect(sessionAlice.etat).toBe('ACTIF');
    expect(sessionAlice.interlocuteurId).toBe('bob@dsi.fr');
    expect(sessionAlice.dernierNumeroSequence).toBe(1);

    // Bob should have automatically recorded the exchange and locked the security level
    const sessionBob = bob.getEchange(sessionAlice.echangeId);
    expect(sessionBob).toBeDefined();
    expect(sessionBob?.echangeId).toBe(sessionAlice.echangeId);
    expect(sessionBob?.niveauSecurite).toBe('NON_SECURISE');
    expect(sessionBob?.etat).toBe('ACTIF');
    expect(sessionBob?.interlocuteurId).toBe('alice@dsi.fr');
    expect(sessionBob?.dernierNumeroSequence).toBe(1);

    // Bob received callback was called with the message
    expect(bobReceived.length).toBe(1);
    expect(bobReceived[0].echangeId).toBe(sessionAlice.echangeId);
    expect(bobReceived[0].typeMessage).toBe('INIT_ECHANGE');
    expect(bobReceived[0].numeroSequence).toBe(1);
    expect(bobReceived[0].expediteurId).toBe('alice@dsi.fr');
    expect(bobReceived[0].destinataireId).toBe('bob@dsi.fr');
    expect(bobReceived[0].texte).toBe('Bonjour Bob !');
    expect(bobReceived[0].niveauSecurite).toBe('NON_SECURISE');
  });

  it('should emit standardized JMS message headers and plaintext body on the inbox queue', () => {
    const broker = new InMemoryJmsBroker();
    let capturedRawMessage: any = null;

    // Spy on the raw queue before registering the client consumer
    const originalSendToQueue = broker.sendToQueue.bind(broker);
    broker.sendToQueue = (queueName: string, input: any) => {
      capturedRawMessage = input;
      originalSendToQueue(queueName, input);
    };

    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const session = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Hello World',
    });

    expect(capturedRawMessage).not.toBeNull();
    expect(capturedRawMessage.headers.JMSCorrelationID).toBe(session.echangeId);
    expect(capturedRawMessage.headers.type_message).toBe('INIT_ECHANGE');
    expect(capturedRawMessage.headers.niveau_securite).toBe('NON_SECURISE');
    expect(capturedRawMessage.headers.expediteur_id).toBe('alice@dsi.fr');
    expect(capturedRawMessage.headers.destinataire_id).toBe('bob@dsi.fr');
    expect(capturedRawMessage.headers.numero_sequence).toBe(1);
    expect(capturedRawMessage.headers.horodatage).toBeDefined();
    expect(new Date(capturedRawMessage.headers.horodatage).getTime()).not.toBeNaN();
    expect(capturedRawMessage.payload).toBe('Hello World');
  });

  it('should support multi-turn bidirectional chat with strictly monotonic sequence numbers', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);

    const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Message 1 (Alice)',
      niveauSecurite: 'NON_SECURISE',
    });
    const echangeId = sessionAlice.echangeId;

    // Turn 2: Bob replies
    bob.envoyerMessage(echangeId, 'Message 2 (Bob)');

    // Turn 3: Alice responds
    alice.envoyerMessage(echangeId, 'Message 3 (Alice)');

    // Turn 4: Bob responds
    bob.envoyerMessage(echangeId, 'Message 4 (Bob)');

    // Turn 5: Alice responds
    alice.envoyerMessage(echangeId, 'Message 5 (Alice)');

    const histAlice = alice.getHistorique(echangeId);
    const histBob = bob.getHistorique(echangeId);

    expect(histAlice.length).toBe(5);
    expect(histBob.length).toBe(5);

    const seqsAlice = histAlice.map((m) => m.numeroSequence);
    const seqsBob = histBob.map((m) => m.numeroSequence);

    expect(seqsAlice).toEqual([1, 2, 3, 4, 5]);
    expect(seqsBob).toEqual([1, 2, 3, 4, 5]);

    // Check texts match
    expect(histAlice.map((m) => m.texte)).toEqual([
      'Message 1 (Alice)',
      'Message 2 (Bob)',
      'Message 3 (Alice)',
      'Message 4 (Bob)',
      'Message 5 (Alice)',
    ]);
    expect(histBob.map((m) => m.texte)).toEqual(histAlice.map((m) => m.texte));
  });

  it('should reject non-monotonic or duplicate sequence numbers', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);

    const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Message 1',
    });
    const echangeId = sessionAlice.echangeId;

    // Trying to send directly with a sequence number <= current sequence
    expect(() => {
      alice.envoyerMessage(echangeId, 'Mauvaise séquence', {
        numeroSequence: 1,
      });
    }).toThrow(/séquence/i);

    // Injecting out-of-order sequence directly into Bob's queue
    expect(() => {
      broker.sendToQueue('queue.chat.inbox.bob@dsi.fr', {
        headers: {
          JMSCorrelationID: echangeId,
          type_message: 'MSG_TEXTE',
          niveau_securite: 'NON_SECURISE',
          expediteur_id: 'alice@dsi.fr',
          destinataire_id: 'bob@dsi.fr',
          numero_sequence: 1, // <= dernier vu 1
          horodatage: new Date().toISOString(),
        },
        payload: 'Rejeu illégitime',
      });
    }).toThrow(/séquence/i);
  });

  it('should reject security downgrade or level mismatch within an active exchange', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);

    const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Hello',
      niveauSecurite: 'NON_SECURISE',
    });
    const echangeId = sessionAlice.echangeId;

    // Sender trying to change security level
    expect(() => {
      alice.envoyerMessage(echangeId, 'Chiffre-moi ça', {
        niveauSecurite: 'CHIFFRE',
      });
    }).toThrow(/niveau de sécurité/i);

    // Direct injection into Bob's inbox with different security level
    expect(() => {
      broker.sendToQueue('queue.chat.inbox.bob@dsi.fr', {
        headers: {
          JMSCorrelationID: echangeId,
          type_message: 'MSG_TEXTE',
          niveau_securite: 'SIGNE', // Locked level is NON_SECURISE
          expediteur_id: 'alice@dsi.fr',
          destinataire_id: 'bob@dsi.fr',
          numero_sequence: 2,
          horodatage: new Date().toISOString(),
        },
        payload: 'Faux message signé',
      });
    }).toThrow(/sécurité/i);

    // Verify Bob's exchange is still locked to NON_SECURISE
    const sessionBob = bob.getEchange(echangeId);
    expect(sessionBob?.niveauSecurite).toBe('NON_SECURISE');
  });

  it('should cleanly close exchange upon FIN_MSG on both ends', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);

    const sessionAlice = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Bonjour',
    });
    const echangeId = sessionAlice.echangeId;

    bob.envoyerMessage(echangeId, 'Salut');

    // Alice closes the exchange by sending FIN_MSG
    alice.envoyerMessage(echangeId, 'FIN_MSG');

    const sessionAliceApres = alice.getEchange(echangeId);
    const sessionBobApres = bob.getEchange(echangeId);

    expect(sessionAliceApres?.etat).toBe('TERMINE');
    expect(sessionBobApres?.etat).toBe('TERMINE');

    const dernierMsgAlice = alice.getHistorique(echangeId).slice(-1)[0];
    const dernierMsgBob = bob.getHistorique(echangeId).slice(-1)[0];

    expect(dernierMsgAlice.typeMessage).toBe('FIN_MSG');
    expect(dernierMsgAlice.texte).toBe('FIN_MSG');
    expect(dernierMsgBob.typeMessage).toBe('FIN_MSG');
    expect(dernierMsgBob.texte).toBe('FIN_MSG');
  });

  it('should support closing exchange via cloreEchange method', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);

    const session = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Discussion rapide',
    });
    const echangeId = session.echangeId;

    bob.cloreEchange(echangeId);

    expect(alice.getEchange(echangeId)?.etat).toBe('TERMINE');
    expect(bob.getEchange(echangeId)?.etat).toBe('TERMINE');
  });

  it('should reject any message sent or received after exchange closure', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);

    const session = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Message initial',
    });
    const echangeId = session.echangeId;

    alice.cloreEchange(echangeId);

    expect(alice.getEchange(echangeId)?.etat).toBe('TERMINE');
    expect(bob.getEchange(echangeId)?.etat).toBe('TERMINE');

    // Attempting to send after closure from Alice
    expect(() => {
      alice.envoyerMessage(echangeId, 'Encore là ?');
    }).toThrow(/terminé/i);

    // Attempting to send after closure from Bob
    expect(() => {
      bob.envoyerMessage(echangeId, 'Moi aussi je parle dans le vide');
    }).toThrow(/terminé/i);

    // Attempting direct delivery into inbox on a closed exchange
    expect(() => {
      broker.sendToQueue('queue.chat.inbox.bob@dsi.fr', {
        headers: {
          JMSCorrelationID: echangeId,
          type_message: 'MSG_TEXTE',
          niveau_securite: 'NON_SECURISE',
          expediteur_id: 'alice@dsi.fr',
          destinataire_id: 'bob@dsi.fr',
          numero_sequence: 3,
          horodatage: new Date().toISOString(),
        },
        payload: 'Message clandestin',
      });
    }).toThrow(/terminé/i);
  });

  it('should handle multiple independent exchanges concurrently', () => {
    const broker = new InMemoryJmsBroker();
    const alice = new CorrespondantClient('alice@dsi.fr', broker);
    const bob = new CorrespondantClient('bob@dsi.fr', broker);
    const charlie = new CorrespondantClient('charlie@dsi.fr', broker);

    const echAliceBob = alice.initialiserEchange('bob@dsi.fr', {
      premierMessage: 'Chat Alice-Bob',
    });
    const echAliceCharlie = alice.initialiserEchange('charlie@dsi.fr', {
      premierMessage: 'Chat Alice-Charlie',
    });

    bob.envoyerMessage(echAliceBob.echangeId, 'Reponse Bob');
    charlie.envoyerMessage(echAliceCharlie.echangeId, 'Reponse Charlie');

    expect(alice.getHistorique(echAliceBob.echangeId).length).toBe(2);
    expect(alice.getHistorique(echAliceCharlie.echangeId).length).toBe(2);

    expect(bob.getHistorique(echAliceBob.echangeId).length).toBe(2);
    expect(charlie.getHistorique(echAliceCharlie.echangeId).length).toBe(2);

    // Closing one exchange does not affect the other
    alice.cloreEchange(echAliceBob.echangeId);

    expect(alice.getEchange(echAliceBob.echangeId)?.etat).toBe('TERMINE');
    expect(alice.getEchange(echAliceCharlie.echangeId)?.etat).toBe('ACTIF');

    // Charlie can still talk to Alice on active exchange
    charlie.envoyerMessage(echAliceCharlie.echangeId, 'Toujours actif');
    expect(alice.getHistorique(echAliceCharlie.echangeId).length).toBe(3);
  });
});
