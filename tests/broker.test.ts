import { describe, it, expect, vi } from 'vitest';
import { InMemoryJmsBroker } from '../src/broker/index.js';

describe('InMemoryJmsBroker', () => {
  it('should publish to topics and notify all active subscribers', () => {
    const broker = new InMemoryJmsBroker();
    const subscriber1 = vi.fn();
    const subscriber2 = vi.fn();

    const unsub1 = broker.subscribe('topic.pki.publications.certificats', subscriber1);
    broker.subscribe('topic.pki.publications.certificats', subscriber2);

    broker.publish('topic.pki.publications.certificats', {
      headers: {
        type_message: 'PUBLICATION_CERTIFICAT',
        ac_emettrice_id: 'AC-N1-RACINE',
        niveau_ac: 1,
        numero_serie: 'SN-ROOT-001',
      },
      payload: {
        numeroSerie: 'SN-ROOT-001',
        sujet: 'AC-N1-RACINE',
      },
    });

    expect(subscriber1).toHaveBeenCalledTimes(1);
    expect(subscriber2).toHaveBeenCalledTimes(1);

    const callArg = subscriber1.mock.calls[0][0];
    expect(callArg.headers.type_message).toBe('PUBLICATION_CERTIFICAT');
    expect(callArg.payload.numeroSerie).toBe('SN-ROOT-001');
    expect(JSON.parse(callArg.body).numeroSerie).toBe('SN-ROOT-001');

    // Unsubscribe test
    unsub1();
    broker.publish('topic.pki.publications.certificats', {
      payload: { test: 123 },
    });

    expect(subscriber1).toHaveBeenCalledTimes(1);
    expect(subscriber2).toHaveBeenCalledTimes(2);
  });

  it('should support point-to-point queues with FIFO consumption', () => {
    const broker = new InMemoryJmsBroker();
    const handler = vi.fn();

    broker.sendToQueue('queue.pki.ac.AC-N3-DSI.demandes', {
      headers: { JMSCorrelationID: 'corr-1' },
      payload: { action: 'create' },
    });
    broker.sendToQueue('queue.pki.ac.AC-N3-DSI.demandes', {
      headers: { JMSCorrelationID: 'corr-2' },
      payload: { action: 'revoke' },
    });

    broker.registerQueueConsumer('queue.pki.ac.AC-N3-DSI.demandes', handler);

    expect(handler).toHaveBeenCalledTimes(2);
    expect(handler.mock.calls[0][0].headers.JMSCorrelationID).toBe('corr-1');
    expect(handler.mock.calls[1][0].headers.JMSCorrelationID).toBe('corr-2');
  });
});
