import { decodeEvent, DecodedEvent } from './indexer.types';

/**
 * Unit tests for the pure decodeEvent() decoder.
 * These tests have zero external dependencies — no NestJS, no DB.
 */
describe('decodeEvent', () => {
  const baseEvent: Omit<DecodedEvent, 'topics' | 'value'> = {
    id: 'ev-001',
    ledger: 100,
    contractId: 'CTOKEN123',
  };

  // ── credit:mint ──────────────────────────────────────────────────────

  describe('mint', () => {
    it('decodes a valid mint event', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['mint', 'GADDR...'],
        value: { amount: 5000n },
      };
      const result = decodeEvent(raw);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('credit:mint');
      if (result?.kind === 'credit:mint') {
        expect(result.to).toBe('GADDR...');
        expect(result.amount).toBe(5000n);
        expect(result.ledger).toBe(100);
        expect(result.contractId).toBe('CTOKEN123');
      } else {
        fail('Expected credit:mint event');
      }
    });

    it('returns null when amount is missing', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['mint', 'GADDR...'],
        value: { notAmount: 5000n },
      };
      expect(decodeEvent(raw)).toBeNull();
    });

    it('returns null when to address is missing', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['mint'],
        value: { amount: 5000n },
      };
      expect(decodeEvent(raw)).toBeNull();
    });
  });

  // ── credit:retire ────────────────────────────────────────────────────

  describe('retire', () => {
    it('decodes a valid retire event', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['retire', 'GFROM...'],
        value: { amount: 1000n, purpose: 'compliance', metadata_uri: 'ipfs://QmABC' },
      };
      const result = decodeEvent(raw);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('credit:retire');
      if (result?.kind === 'credit:retire') {
        expect(result.from).toBe('GFROM...');
        expect(result.amount).toBe(1000n);
        expect(result.purpose).toBe('compliance');
        expect(result.metadataUri).toBe('ipfs://QmABC');
      } else {
        fail('Expected credit:retire event');
      }
    });

    it('defaults purpose and metadataUri to empty string when absent', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['retire', 'GFROM...'],
        value: { amount: 1000n },
      };
      const result = decodeEvent(raw);
      expect(result!.kind).toBe('credit:retire');
      if (result?.kind === 'credit:retire') {
        expect(result.purpose).toBe('');
        expect(result.metadataUri).toBe('');
      } else {
        fail('Expected credit:retire event');
      }
    });
  });

  // ── credit:transfer ──────────────────────────────────────────────────

  describe('transfer', () => {
    it('decodes a valid transfer event', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['transfer', 'GFROM...', 'GTO...'],
        value: { amount: 200n },
      };
      const result = decodeEvent(raw);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('credit:transfer');
      if (result?.kind === 'credit:transfer') {
        expect(result.from).toBe('GFROM...');
        expect(result.to).toBe('GTO...');
        expect(result.amount).toBe(200n);
      } else {
        fail('Expected credit:transfer event');
      }
    });
  });

  // ── oracle:reading_submitted ─────────────────────────────────────────

  describe('reading_submitted', () => {
    it('decodes a valid reading_submitted event', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['reading_submitted', 'proj-uuid-001', 'GORACLE...'],
        value: { nonce: 42, credits_awarded: 750n },
      };
      const result = decodeEvent(raw);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('oracle:reading_submitted');
      if (result?.kind === 'oracle:reading_submitted') {
        expect(result.projectId).toBe('proj-uuid-001');
        expect(result.oracleAddress).toBe('GORACLE...');
        expect(result.nonce).toBe(42);
        expect(result.creditsAwarded).toBe(750n);
      } else {
        fail('Expected oracle:reading_submitted event');
      }
    });

    it('defaults creditsAwarded to 0n when absent', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['reading_submitted', 'proj-uuid-001', 'GORACLE...'],
        value: { nonce: 1 },
      };
      const result = decodeEvent(raw);
      expect(result!.kind).toBe('oracle:reading_submitted');
      if (result?.kind === 'oracle:reading_submitted') {
        expect(result.creditsAwarded).toBe(0n);
      } else {
        fail('Expected oracle:reading_submitted event');
      }
    });

    it('returns null when nonce is missing', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['reading_submitted', 'proj-uuid-001', 'GORACLE...'],
        value: { credits_awarded: 100n },
      };
      expect(decodeEvent(raw)).toBeNull();
    });
  });

  // ── governance:proposal_executed ────────────────────────────────────

  describe('proposal_executed', () => {
    it('decodes a valid proposal_executed event', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['proposal_executed', 7],
        value: { executed_by: 'GADMIN...' },
      };
      const result = decodeEvent(raw);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('governance:proposal_executed');
      if (result?.kind === 'governance:proposal_executed') {
        expect(result.onChainProposalId).toBe(7);
        expect(result.executedBy).toBe('GADMIN...');
      } else {
        fail('Expected governance:proposal_executed event');
      }
    });

    it('returns null when proposalId is missing', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['proposal_executed'],
        value: { executed_by: 'GADMIN...' },
      };
      expect(decodeEvent(raw)).toBeNull();
    });
  });

  // ── governance:vote_cast ─────────────────────────────────────────────

  describe('vote_cast', () => {
    it('decodes a valid vote_cast event (support)', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['vote_cast', 7, 'GVOTER...'],
        value: { support: true },
      };
      const result = decodeEvent(raw);
      expect(result).not.toBeNull();
      expect(result!.kind).toBe('governance:vote_cast');
      if (result?.kind === 'governance:vote_cast') {
        expect(result.onChainProposalId).toBe(7);
        expect(result.voterWallet).toBe('GVOTER...');
        expect(result.support).toBe(true);
      } else {
        fail('Expected governance:vote_cast event');
      }
    });

    it('decodes a valid vote_cast event (against)', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['vote_cast', 7, 'GVOTER...'],
        value: { support: false },
      };
      const result = decodeEvent(raw);
      expect(result!.kind).toBe('governance:vote_cast');
      if (result?.kind === 'governance:vote_cast') {
        expect(result.support).toBe(false);
      } else {
        fail('Expected governance:vote_cast event');
      }
    });

    it('returns null when proposalId is missing', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['vote_cast'],
        value: { support: true },
      };
      expect(decodeEvent(raw)).toBeNull();
    });

    it('returns null when voter address is missing', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['vote_cast', 7],
        value: { support: true },
      };
      expect(decodeEvent(raw)).toBeNull();
    });

    it('returns null when support is missing or not a boolean', () => {
      const raw: DecodedEvent = {
        ...baseEvent,
        topics: ['vote_cast', 7, 'GVOTER...'],
        value: { support: 'yes' },
      };
      expect(decodeEvent(raw)).toBeNull();
    });
  });

  // ── Unknown / malformed ──────────────────────────────────────────────

  it('returns null for an unrecognised event name', () => {
    const raw: DecodedEvent = {
      ...baseEvent,
      topics: ['foobar', 'GADDR...'],
      value: {},
    };
    expect(decodeEvent(raw)).toBeNull();
  });

  it('returns null when the event name is not a string', () => {
    const raw: DecodedEvent = {
      ...baseEvent,
      topics: [42, 'GADDR...'],
      value: {},
    };
    expect(decodeEvent(raw)).toBeNull();
  });

  it('returns null when topics array is empty', () => {
    const raw: DecodedEvent = {
      ...baseEvent,
      topics: [],
      value: {},
    };
    expect(decodeEvent(raw)).toBeNull();
  });

  // ── Number coercion ──────────────────────────────────────────────────

  it('accepts numeric amount encoded as string', () => {
    const raw: DecodedEvent = {
      ...baseEvent,
      topics: ['mint', 'GADDR...'],
      value: { amount: '99999' },
    };
    const result = decodeEvent(raw);
    expect(result!.kind).toBe('credit:mint');
    if (result?.kind === 'credit:mint') {
      expect(result.amount).toBe(99999n);
    } else {
      fail('Expected credit:mint event');
    }
  });

  it('accepts nonce encoded as bigint', () => {
    const raw: DecodedEvent = {
      ...baseEvent,
      topics: ['reading_submitted', 'proj-uuid-001', 'GORACLE...'],
      value: { nonce: 5n, credits_awarded: 0n },
    };
    const result = decodeEvent(raw);
    expect(result!.kind).toBe('oracle:reading_submitted');
    if (result?.kind === 'oracle:reading_submitted') {
      expect(result.nonce).toBe(5);
    } else {
      fail('Expected oracle:reading_submitted event');
    }
  });
});
