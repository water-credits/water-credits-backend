/**
 * Shared validation utilities for allowlist management scripts.
 *
 * Validates asset codes, issuer addresses, network configuration, and
 * contract reachability before any on-chain submission is attempted.
 *
 * Designed for use by:
 *   - allowlist-add.ts
 *   - allowlist-revoke.ts
 */

import { Keypair, SorobanRpc, Contract, Account, TransactionBuilder } from '@stellar/stellar-sdk';

// ── Network Presets ───────────────────────────────────────────────────────────

export interface NetworkConfig {
  name: 'testnet' | 'mainnet';
  rpcUrl: string;
  passphrase: string;
  horizonUrl: string;
}

export const NETWORKS: Record<string, NetworkConfig> = {
  testnet: {
    name: 'testnet',
    rpcUrl: 'https://soroban-testnet.stellar.org',
    passphrase: 'Test SDF Network ; September 2015',
    horizonUrl: 'https://horizon-testnet.stellar.org',
  },
  mainnet: {
    name: 'mainnet',
    rpcUrl: 'https://soroban-mainnet.stellar.org',
    passphrase: 'Public Global Stellar Network ; September 2015',
    horizonUrl: 'https://horizon.stellar.org',
  },
};

// ── Validation errors ─────────────────────────────────────────────────────────

export class ValidationError extends Error {
  constructor(
    public readonly field: string,
    message: string,
  ) {
    super(message);
    this.name = 'ValidationError';
  }
}

// ── Asset code validation ─────────────────────────────────────────────────────

/**
 * Validates a Stellar asset code.
 * - 1–4 characters: alphanumeric (native assets, e.g. USDC short form)
 * - 5–12 characters: alphanumeric
 * - "XLM" is the native asset and cannot be added to an allowlist
 *
 * @throws {ValidationError} if the code is invalid
 */
export function validateAssetCode(code: string): void {
  if (!code || typeof code !== 'string') {
    throw new ValidationError('assetCode', 'Asset code is required');
  }

  const trimmed = code.trim();

  if (trimmed === 'XLM') {
    throw new ValidationError(
      'assetCode',
      'XLM is the native asset and cannot be added to an allowlist',
    );
  }

  if (!/^[A-Z0-9]{1,12}$/.test(trimmed)) {
    throw new ValidationError(
      'assetCode',
      `Invalid asset code "${trimmed}": must be 1–12 uppercase alphanumeric characters`,
    );
  }
}

// ── Issuer address validation ─────────────────────────────────────────────────

/**
 * Validates a Stellar account address (G… StrKey format).
 *
 * @throws {ValidationError} if the address is not a valid Stellar account ID
 */
export function validateIssuerAddress(issuer: string): void {
  if (!issuer || typeof issuer !== 'string') {
    throw new ValidationError('issuer', 'Issuer address is required');
  }

  const trimmed = issuer.trim();

  if (!trimmed.startsWith('G')) {
    throw new ValidationError(
      'issuer',
      `Invalid issuer address "${trimmed}": must start with G`,
    );
  }

  try {
    Keypair.fromPublicKey(trimmed);
  } catch {
    throw new ValidationError(
      'issuer',
      `Invalid issuer address "${trimmed}": not a valid Stellar public key`,
    );
  }
}

// ── Operator secret validation ────────────────────────────────────────────────

/**
 * Validates the operator secret key (S… StrKey format).
 * Only checks format — does not verify the key has admin privileges on-chain.
 *
 * @throws {ValidationError} if the secret is malformed
 */
export function validateOperatorSecret(secret: string): Keypair {
  if (!secret || typeof secret !== 'string') {
    throw new ValidationError('operatorSecret', 'Operator secret key is required');
  }

  const trimmed = secret.trim();

  if (!trimmed.startsWith('S')) {
    throw new ValidationError(
      'operatorSecret',
      'Operator secret key must start with S',
    );
  }

  try {
    return Keypair.fromSecret(trimmed);
  } catch {
    throw new ValidationError(
      'operatorSecret',
      'Operator secret key is not a valid Stellar secret key',
    );
  }
}

// ── Contract ID validation ────────────────────────────────────────────────────

/**
 * Validates a Soroban contract ID (C… StrKey format).
 *
 * @throws {ValidationError} if the contract ID is malformed
 */
export function validateContractId(contractId: string): void {
  if (!contractId || typeof contractId !== 'string') {
    throw new ValidationError('contractId', 'Contract ID is required');
  }

  const trimmed = contractId.trim();

  if (!trimmed.startsWith('C')) {
    throw new ValidationError(
      'contractId',
      `Invalid contract ID "${trimmed}": Soroban contract IDs start with C`,
    );
  }

  if (trimmed.length !== 56) {
    throw new ValidationError(
      'contractId',
      `Invalid contract ID "${trimmed}": expected 56 characters, got ${trimmed.length}`,
    );
  }
}

// ── Network config resolution ─────────────────────────────────────────────────

/**
 * Resolves the network config from a network name string.
 * Accepts "testnet" or "mainnet" (case-insensitive).
 *
 * @throws {ValidationError} if the network name is not recognised
 */
export function resolveNetwork(networkName: string): NetworkConfig {
  const key = networkName.toLowerCase().trim();

  if (!(key in NETWORKS)) {
    throw new ValidationError(
      'network',
      `Unknown network "${networkName}". Valid options: testnet, mainnet`,
    );
  }

  return NETWORKS[key];
}

// ── RPC reachability probe ────────────────────────────────────────────────────

/**
 * Probes the RPC endpoint to confirm it is reachable and returns the
 * current latest ledger number.  Throws a plain Error (not ValidationError)
 * on failure — the caller should surface this as a connectivity issue, not
 * a user input problem.
 */
export async function probeRpcEndpoint(rpcUrl: string): Promise<{ latestLedger: number }> {
  const server = new SorobanRpc.Server(rpcUrl);

  try {
    const { sequence } = await server.getLatestLedger();
    return { latestLedger: sequence };
  } catch (err) {
    throw new Error(
      `Cannot reach RPC endpoint at ${rpcUrl}: ${(err as Error).message ?? String(err)}`,
    );
  }
}

// ── Contract existence probe ──────────────────────────────────────────────────

/**
 * Confirms that a Soroban contract exists at the given ID by running a
 * trivial simulation.  Uses the method name specified (defaults to a
 * read-only probe via a non-destructive call) against a random ephemeral
 * account so no funds are required.
 *
 * Returns true if the simulation does not produce a "contract not found"
 * error — it is acceptable for the simulation to fail for other reasons
 * (e.g. wrong argument count) because that still proves the contract exists.
 */
export async function probeContractExists(
  rpcUrl: string,
  networkPassphrase: string,
  contractId: string,
): Promise<boolean> {
  const server = new SorobanRpc.Server(rpcUrl);
  const contract = new Contract(contractId);
  const ephemeralKeypair = Keypair.random();

  const tx = new TransactionBuilder(new Account(ephemeralKeypair.publicKey(), '0'), {
    fee: '100',
    networkPassphrase,
  })
    .addOperation(contract.call('version')) // lightweight read; may not exist — that is fine
    .setTimeout(0)
    .build();

  try {
    const simulation = await server.simulateTransaction(tx);

    // A simulation error referencing "ContractNotFound" or similar xdr error
    // means the contract ID does not exist on-chain.
    if (SorobanRpc.Api.isSimulationError(simulation)) {
      const errMsg = simulation.error ?? '';
      if (
        errMsg.toLowerCase().includes('missingvalue') ||
        errMsg.toLowerCase().includes('contractnotfound') ||
        errMsg.toLowerCase().includes('no such contract')
      ) {
        return false;
      }
    }

    // Any other result (success, different error) means the contract exists.
    return true;
  } catch (err) {
    // Network / transport errors are re-thrown so the caller can distinguish
    // them from a missing-contract situation.
    throw new Error(
      `Contract existence probe failed for ${contractId}: ${(err as Error).message ?? String(err)}`,
    );
  }
}

// ── Dry-run simulation ────────────────────────────────────────────────────────

export interface DryRunResult {
  success: boolean;
  /** Estimated fee in stroops */
  estimatedFee: string;
  /** Human-readable simulation error if the call would revert */
  error?: string;
  /** Raw simulation response for advanced diagnostics */
  raw: SorobanRpc.Api.SimulateTransactionResponse;
}

/**
 * Simulates a contract invocation transaction and returns a structured
 * result.  A simulation success indicates the call is _likely_ to succeed
 * when submitted for real — it is not a guarantee (e.g. state may change
 * between simulate and submit).
 */
export async function dryRunTransaction(
  rpcUrl: string,
  tx: ReturnType<TransactionBuilder['build']>,
): Promise<DryRunResult> {
  const server = new SorobanRpc.Server(rpcUrl);
  const simulation = await server.simulateTransaction(tx);

  if (SorobanRpc.Api.isSimulationError(simulation)) {
    return {
      success: false,
      estimatedFee: '0',
      error: simulation.error ?? 'Unknown simulation error',
      raw: simulation,
    };
  }

  const fee = SorobanRpc.Api.isSimulationSuccess(simulation)
    ? simulation.minResourceFee ?? '100'
    : '100';

  return {
    success: true,
    estimatedFee: fee,
    raw: simulation,
  };
}

// ── Pretty print helpers ──────────────────────────────────────────────────────

export const COLORS = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
};

export function ok(msg: string): void {
  console.log(`${COLORS.green}✓${COLORS.reset} ${msg}`);
}

export function warn(msg: string): void {
  console.warn(`${COLORS.yellow}⚠${COLORS.reset} ${msg}`);
}

export function fail(msg: string): void {
  console.error(`${COLORS.red}✗${COLORS.reset} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${COLORS.cyan}ℹ${COLORS.reset} ${msg}`);
}

export function section(title: string): void {
  console.log(`\n${COLORS.bold}${COLORS.white}── ${title}${COLORS.reset}`);
}

export function banner(action: string, dryRun: boolean): void {
  const mode = dryRun
    ? `${COLORS.yellow}DRY-RUN (no changes will be made)${COLORS.reset}`
    : `${COLORS.red}${COLORS.bold}LIVE (changes will be submitted on-chain)${COLORS.reset}`;

  console.log(
    `\n${COLORS.bold}${COLORS.cyan}╔══════════════════════════════════════════╗${COLORS.reset}`,
  );
  console.log(
    `${COLORS.bold}${COLORS.cyan}║  Water Credits — Allowlist ${action.padEnd(14)}║${COLORS.reset}`,
  );
  console.log(
    `${COLORS.bold}${COLORS.cyan}╚══════════════════════════════════════════╝${COLORS.reset}`,
  );
  console.log(`  Mode: ${mode}\n`);
}
