/**
 * Typed representations of on-chain Soroban contract events emitted by the
 * four contracts the indexer monitors:
 *
 *   - credit_token   → mint | retire | transfer
 *   - verification_oracle → reading_submitted
 *   - governance     → proposal_executed
 *
 * Each event's ScVal topics/data are decoded via scValToNative() before being
 * passed to the type guards below.  Using plain interfaces + type-guard
 * functions (rather than a class hierarchy) keeps the decoder zero-dependency
 * and easy to test in isolation.
 */

// ── Raw decoded event shape ────────────────────────────────────────────────

/**
 * The shape of a single event returned by SorobanRpc.Server.getEvents()
 * after the topics and value have been decoded through scValToNative().
 */
export interface DecodedEvent {
  /** Ledger sequence the event was emitted in. */
  ledger: number;
  /** Contract that emitted the event. */
  contractId: string;
  /**
   * Decoded topic array.  Topic[0] is conventionally the event name (a
   * Symbol ScVal decoded to a plain string by scValToNative).
   */
  topics: unknown[];
  /** Decoded event body value (may be a map, scalar, or null). */
  value: unknown;
  /** Unique event identifier returned by the RPC (used for deduplication). */
  id: string;
}

// ── credit_token events ────────────────────────────────────────────────────

export interface CreditMintEvent {
  kind: 'credit:mint';
  contractId: string;
  ledger: number;
  /** Beneficiary wallet address. */
  to: string;
  /** Credit amount (integer units). */
  amount: bigint;
  id: string;
}

export interface CreditRetireEvent {
  kind: 'credit:retire';
  contractId: string;
  ledger: number;
  /** Wallet that retired the credits. */
  from: string;
  /** Credit amount retired (integer units). */
  amount: bigint;
  /** Retirement purpose string (e.g. 'compliance'). */
  purpose: string;
  /** Optional metadata URI (IPFS or similar). */
  metadataUri: string;
  id: string;
}

export interface CreditTransferEvent {
  kind: 'credit:transfer';
  contractId: string;
  ledger: number;
  from: string;
  to: string;
  amount: bigint;
  id: string;
}

// ── verification_oracle events ─────────────────────────────────────────────

export interface OracleReadingSubmittedEvent {
  kind: 'oracle:reading_submitted';
  contractId: string;
  ledger: number;
  /** Off-chain project identifier. */
  projectId: string;
  /** Oracle wallet address that submitted. */
  oracleAddress: string;
  /** Submission nonce. */
  nonce: number;
  /** Credits awarded (may be 0 when quality thresholds were not met). */
  creditsAwarded: bigint;
  id: string;
}

// ── governance events ──────────────────────────────────────────────────────

export interface GovernanceProposalExecutedEvent {
  kind: 'governance:proposal_executed';
  contractId: string;
  ledger: number;
  /** On-chain u32 proposal identifier. */
  onChainProposalId: number;
  /** Wallet that called execute(). */
  executedBy: string;
  id: string;
}

export interface GovernanceVoteCastEvent {
  kind: 'governance:vote_cast';
  contractId: string;
  ledger: number;
  /** On-chain u32 proposal identifier. */
  onChainProposalId: number;
  /** Wallet that cast the vote. */
  voterWallet: string;
  /** true = vote for, false = vote against. */
  support: boolean;
  id: string;
}

// ── Union type ─────────────────────────────────────────────────────────────

export type IndexedEvent =
  | CreditMintEvent
  | CreditRetireEvent
  | CreditTransferEvent
  | OracleReadingSubmittedEvent
  | GovernanceProposalExecutedEvent
  | GovernanceVoteCastEvent;

// ── Decoder ───────────────────────────────────────────────────────────────

/**
 * Converts a raw decoded RPC event into a typed IndexedEvent, or returns null
 * if the event does not match any known schema (e.g. unknown topic, wrong
 * field count).  Callers must handle null — the indexer logs and skips it.
 *
 * The Soroban event topic convention used by the water-credits contracts:
 *   topics[0]  → event name  (Symbol, decoded to string)
 *   topics[1…] → key fields  (Address decoded to string, u32 to number, etc.)
 *   value      → payload map (decoded to plain object by scValToNative)
 *
 * All bigint conversions use BigInt() so the function never throws on large
 * i128 values that exceed Number.MAX_SAFE_INTEGER.
 */
export function decodeEvent(raw: DecodedEvent): IndexedEvent | null {
  const [eventName, ...keyTopics] = raw.topics;
  if (typeof eventName !== 'string') {
    return null;
  }

  try {
    switch (eventName) {
      case 'mint': {
        // topics: ['mint', <to_address>]
        // value:  { amount: bigint }
        const to = asString(keyTopics[0]);
        const payload = asMap(raw.value);
        if (!to || !payload) return null;
        const amount = asBigInt(payload['amount']);
        if (amount === null) return null;
        return {
          kind: 'credit:mint',
          contractId: raw.contractId,
          ledger: raw.ledger,
          to,
          amount,
          id: raw.id,
        };
      }

      case 'retire': {
        // topics: ['retire', <from_address>]
        // value:  { amount: bigint, purpose: string, metadata_uri: string }
        const from = asString(keyTopics[0]);
        const payload = asMap(raw.value);
        if (!from || !payload) return null;
        const amount = asBigInt(payload['amount']);
        const purpose = asString(payload['purpose']) ?? '';
        const metadataUri = asString(payload['metadata_uri']) ?? '';
        if (amount === null) return null;
        return {
          kind: 'credit:retire',
          contractId: raw.contractId,
          ledger: raw.ledger,
          from,
          amount,
          purpose,
          metadataUri,
          id: raw.id,
        };
      }

      case 'transfer': {
        // topics: ['transfer', <from_address>, <to_address>]
        // value:  { amount: bigint }
        const from = asString(keyTopics[0]);
        const to = asString(keyTopics[1]);
        const payload = asMap(raw.value);
        if (!from || !to || !payload) return null;
        const amount = asBigInt(payload['amount']);
        if (amount === null) return null;
        return {
          kind: 'credit:transfer',
          contractId: raw.contractId,
          ledger: raw.ledger,
          from,
          to,
          amount,
          id: raw.id,
        };
      }

      case 'reading_submitted': {
        // topics: ['reading_submitted', <project_id_str>, <oracle_address>]
        // value:  { nonce: number, credits_awarded: bigint }
        const projectId = asString(keyTopics[0]);
        const oracleAddress = asString(keyTopics[1]);
        const payload = asMap(raw.value);
        if (!projectId || !oracleAddress || !payload) return null;
        const nonce = asNumber(payload['nonce']);
        const creditsAwarded = asBigInt(payload['credits_awarded']) ?? 0n;
        if (nonce === null) return null;
        return {
          kind: 'oracle:reading_submitted',
          contractId: raw.contractId,
          ledger: raw.ledger,
          projectId,
          oracleAddress,
          nonce,
          creditsAwarded,
          id: raw.id,
        };
      }

      case 'proposal_executed': {
        // topics: ['proposal_executed', <on_chain_proposal_id u32>]
        // value:  { executed_by: string }
        const onChainProposalId = asNumber(keyTopics[0]);
        const payload = asMap(raw.value);
        if (onChainProposalId === null || !payload) return null;
        const executedBy = asString(payload['executed_by']) ?? '';
        return {
          kind: 'governance:proposal_executed',
          contractId: raw.contractId,
          ledger: raw.ledger,
          onChainProposalId,
          executedBy,
          id: raw.id,
        };
      }

      case 'vote_cast': {
        // topics: ['vote_cast', <on_chain_proposal_id u32>, <voter_address>]
        // value:  { support: bool }
        const onChainProposalId = asNumber(keyTopics[0]);
        const voterWallet = asString(keyTopics[1]);
        const payload = asMap(raw.value);
        if (onChainProposalId === null || !voterWallet || !payload) return null;
        const support = asBoolean(payload['support']);
        if (support === null) return null;
        return {
          kind: 'governance:vote_cast',
          contractId: raw.contractId,
          ledger: raw.ledger,
          onChainProposalId,
          voterWallet,
          support,
          id: raw.id,
        };
      }

      default:
        return null;
    }
  } catch {
    return null;
  }
}

// ── Coercion helpers ──────────────────────────────────────────────────────

function asString(v: unknown): string | null {
  if (typeof v === 'string') return v;
  // Stellar SDK sometimes decodes Address ScVals as objects with .toString()
  if (v !== null && typeof v === 'object' && typeof (v as { toString(): string }).toString === 'function') {
    const s = (v as { toString(): string }).toString();
    return s === '[object Object]' ? null : s;
  }
  return null;
}

function asMap(v: unknown): Record<string, unknown> | null {
  if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
    return v as Record<string, unknown>;
  }
  return null;
}

function asBigInt(v: unknown): bigint | null {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(Math.round(v));
  if (typeof v === 'string') {
    try { return BigInt(v); } catch { return null; }
  }
  return null;
}

function asBoolean(v: unknown): boolean | null {
  if (typeof v === 'boolean') return v;
  return null;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') {
    const n = Number(v);
    return isNaN(n) ? null : n;
  }
  return null;
}
