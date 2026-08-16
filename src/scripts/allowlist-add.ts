/**
 * Allowlist Add Script
 *
 * Adds an asset (code + issuer) to the deployed Water Credits Soroban
 * contract's allowlist.  Always performs a dry-run simulation first; the
 * actual on-chain submission is skipped unless --confirm is passed.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/allowlist-add.ts \
 *     --asset-code USDC \
 *     --issuer GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN \
 *     [--contract CONTRACT_ID] \
 *     [--network testnet|mainnet] \
 *     [--confirm]
 *
 * Environment variables (override CLI flags where both are provided):
 *   STELLAR_NETWORK          testnet | mainnet  (default: testnet)
 *   STELLAR_RPC_URL          Custom RPC endpoint (overrides preset)
 *   STELLAR_PASSPHRASE       Custom network passphrase (overrides preset)
 *   STELLAR_BACKEND_SECRET   Operator secret key  (S…)
 *   CONTRACT_ALLOWLIST_ID    Target contract ID   (C…)
 *
 * Exit codes:
 *   0  — success (or dry-run confirmed valid)
 *   1  — validation / pre-flight error
 *   2  — dry-run simulation failure
 *   3  — on-chain submission error
 */
/* eslint-disable no-console */

import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'path';
import * as process from 'process';

import {
  Keypair,
  SorobanRpc,
  Contract,
  Account,
  TransactionBuilder,
  nativeToScVal,
  Address,
} from '@stellar/stellar-sdk';

import {
  validateAssetCode,
  validateIssuerAddress,
  validateOperatorSecret,
  validateContractId,
  resolveNetwork,
  probeRpcEndpoint,
  probeContractExists,
  dryRunTransaction,
  ValidationError,
  ok,
  warn,
  fail,
  info,
  section,
  banner,
  COLORS,
} from './allowlist-validate';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── CLI argument parsing ──────────────────────────────────────────────────────

interface CliArgs {
  assetCode: string;
  issuer: string;
  contractId: string;
  network: string;
  confirm: boolean;
  rpcUrl?: string;
  passphrase?: string;
}

function parseArgs(argv: string[]): CliArgs {
  const args: Record<string, string | boolean> = {};
  const raw = argv.slice(2); // strip node + script path

  for (let i = 0; i < raw.length; i++) {
    const arg = raw[i];
    if (arg === '--confirm') {
      args['confirm'] = true;
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const value = raw[i + 1];
      if (!value || value.startsWith('--')) {
        fail(`Flag ${arg} requires a value`);
        process.exit(1);
      }
      args[key] = value;
      i++;
    }
  }

  return {
    assetCode: (args['asset-code'] as string) ?? '',
    issuer: (args['issuer'] as string) ?? '',
    contractId: (args['contract'] as string) ?? process.env.CONTRACT_ALLOWLIST_ID ?? '',
    network: (args['network'] as string) ?? process.env.STELLAR_NETWORK ?? 'testnet',
    confirm: (args['confirm'] as boolean) ?? false,
    rpcUrl: (args['rpc-url'] as string) ?? process.env.STELLAR_RPC_URL,
    passphrase: (args['passphrase'] as string) ?? process.env.STELLAR_PASSPHRASE,
  };
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const args = parseArgs(process.argv);

  banner('ADD', !args.confirm);

  // ── Step 1: Input validation ───────────────────────────────────────────────
  section('1/5  Validating inputs');

  try {
    validateAssetCode(args.assetCode);
    ok(`Asset code: ${COLORS.bold}${args.assetCode}${COLORS.reset}`);

    validateIssuerAddress(args.issuer);
    ok(`Issuer:     ${COLORS.bold}${args.issuer}${COLORS.reset}`);

    validateContractId(args.contractId);
    ok(`Contract:   ${COLORS.bold}${args.contractId}${COLORS.reset}`);
  } catch (err) {
    if (err instanceof ValidationError) {
      fail(`${err.field}: ${err.message}`);
      console.error(
        `\nFix the above input error and retry. Run with --help for usage information.`,
      );
    } else {
      fail((err as Error).message);
    }
    process.exit(1);
  }

  // ── Resolve operator keypair ───────────────────────────────────────────────
  const operatorSecret = process.env.STELLAR_BACKEND_SECRET ?? '';
  let operatorKeypair: Keypair;

  try {
    operatorKeypair = validateOperatorSecret(operatorSecret);
    ok(`Operator:   ${COLORS.bold}${operatorKeypair.publicKey()}${COLORS.reset}`);
  } catch (err) {
    if (err instanceof ValidationError) {
      fail(`${err.field}: ${err.message}`);
      info('Set STELLAR_BACKEND_SECRET in your .env to the operator admin secret key (S…)');
    } else {
      fail((err as Error).message);
    }
    process.exit(1);
  }

  // ── Resolve network ────────────────────────────────────────────────────────
  let networkConfig;

  try {
    networkConfig = resolveNetwork(args.network);
  } catch (err) {
    if (err instanceof ValidationError) {
      fail(`${err.field}: ${err.message}`);
    } else {
      fail((err as Error).message);
    }
    process.exit(1);
  }

  // Allow env overrides for custom networks / local devnets
  if (args.rpcUrl) networkConfig = { ...networkConfig, rpcUrl: args.rpcUrl };
  if (args.passphrase) networkConfig = { ...networkConfig, passphrase: args.passphrase };

  ok(`Network:    ${COLORS.bold}${networkConfig.name}${COLORS.reset} (${networkConfig.rpcUrl})`);

  // ── Step 2: Network reachability ───────────────────────────────────────────
  section('2/5  Checking network connectivity');

  try {
    const { latestLedger } = await probeRpcEndpoint(networkConfig.rpcUrl);
    ok(`RPC reachable — latest ledger: ${COLORS.bold}${latestLedger}${COLORS.reset}`);
  } catch (err) {
    fail((err as Error).message);
    info(
      'Check STELLAR_RPC_URL in your .env or pass --rpc-url to point at a reachable endpoint.',
    );
    process.exit(1);
  }

  // ── Step 3: Contract existence ─────────────────────────────────────────────
  section('3/5  Verifying contract exists on-chain');

  try {
    const exists = await probeContractExists(
      networkConfig.rpcUrl,
      networkConfig.passphrase,
      args.contractId,
    );

    if (!exists) {
      fail(`Contract ${args.contractId} was not found on ${networkConfig.name}`);
      info('Double-check CONTRACT_ALLOWLIST_ID in your .env or pass --contract <ID>.');
      process.exit(1);
    }

    ok(`Contract found on ${networkConfig.name}`);
  } catch (err) {
    fail(`Contract probe failed: ${(err as Error).message}`);
    process.exit(1);
  }

  // ── Step 4: Dry-run simulation ─────────────────────────────────────────────
  section('4/5  Simulating add_asset (dry-run)');

  const server = new SorobanRpc.Server(networkConfig.rpcUrl);

  // Fetch operator account for sequence number
  let operatorAccount: Account;
  try {
    const accountData = await server.getAccount(operatorKeypair.publicKey());
    operatorAccount = new Account(accountData.accountId(), accountData.sequenceNumber());
  } catch (err) {
    fail(
      `Could not load operator account ${operatorKeypair.publicKey()}: ${(err as Error).message}`,
    );
    info(
      'Ensure the operator account is funded and exists on ' +
        networkConfig.name +
        '. Use Friendbot for testnet.',
    );
    process.exit(1);
  }

  const contract = new Contract(args.contractId);

  const tx = new TransactionBuilder(operatorAccount, {
    fee: '100',
    networkPassphrase: networkConfig.passphrase,
  })
    .addOperation(
      contract.call(
        'add_asset',
        nativeToScVal(args.assetCode, { type: 'string' }),
        new Address(args.issuer).toScVal(),
      ),
    )
    .setTimeout(30)
    .build();

  const dryRun = await dryRunTransaction(networkConfig.rpcUrl, tx);

  if (!dryRun.success) {
    fail(`Simulation failed — the call would revert on-chain.`);
    console.error(`\n  Error: ${COLORS.red}${dryRun.error}${COLORS.reset}`);
    console.error('\nPossible causes:');
    console.error('  • The asset is already on the allowlist');
    console.error('  • The operator key does not have admin privileges on this contract');
    console.error('  • The contract does not expose an add_asset(code, issuer) method');
    console.error('\nRaw simulation response:');
    console.error(JSON.stringify(dryRun.raw, null, 2));
    process.exit(2);
  }

  ok(`Simulation successful`);
  info(`Estimated fee: ${COLORS.bold}${dryRun.estimatedFee} stroops${COLORS.reset}`);

  // ── Step 5: Submit (only when --confirm is provided) ──────────────────────
  section('5/5  On-chain submission');

  if (!args.confirm) {
    warn(
      'Dry-run only — no changes were made to the contract.\n' +
        `  Re-run with ${COLORS.bold}--confirm${COLORS.reset} to submit the transaction on-chain.`,
    );
    console.log();
    ok('Dry-run complete. All checks passed.');
    process.exit(0);
  }

  info('--confirm flag detected — submitting transaction…');

  try {
    // Re-prepare using the simulation result to attach resource limits
    const preparedTx = await server.prepareTransaction(tx);
    preparedTx.sign(operatorKeypair);

    const sendResponse = await server.sendTransaction(preparedTx);

    if (sendResponse.status === 'ERROR') {
      fail(`Transaction rejected: ${JSON.stringify(sendResponse)}`);
      process.exit(3);
    }

    info(`Transaction submitted — hash: ${COLORS.bold}${sendResponse.hash}${COLORS.reset}`);
    info('Polling for confirmation…');

    let statusResponse = await server.getTransaction(sendResponse.hash);
    let attempts = 0;
    const maxAttempts = 30;

    while (attempts < maxAttempts) {
      if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        console.log();
        ok(`${COLORS.bold}${COLORS.green}Asset successfully added to the allowlist.${COLORS.reset}`);
        console.log(`\n  Asset code:    ${COLORS.bold}${args.assetCode}${COLORS.reset}`);
        console.log(`  Issuer:        ${COLORS.bold}${args.issuer}${COLORS.reset}`);
        console.log(`  Contract:      ${COLORS.bold}${args.contractId}${COLORS.reset}`);
        console.log(`  Network:       ${COLORS.bold}${networkConfig.name}${COLORS.reset}`);
        console.log(`  Tx hash:       ${COLORS.bold}${sendResponse.hash}${COLORS.reset}`);
        console.log(
          `  Explorer:      https://stellar.expert/explorer/${networkConfig.name}/tx/${sendResponse.hash}`,
        );
        process.exit(0);
      }

      if (statusResponse.status === SorobanRpc.Api.GetTransactionStatus.FAILED) {
        fail(`Transaction failed on-chain.`);
        console.error(`  Result XDR: ${statusResponse.resultMetaXdr}`);
        process.exit(3);
      }

      await new Promise((resolve) => setTimeout(resolve, 2000));
      statusResponse = await server.getTransaction(sendResponse.hash);
      attempts++;
      process.stdout.write('.');
    }

    fail(`Transaction polling timed out (hash: ${sendResponse.hash})`);
    info('The transaction may still land. Check the explorer for status.');
    process.exit(3);
  } catch (err) {
    fail(`Submission error: ${(err as Error).message}`);
    process.exit(3);
  }
}

main().catch((err) => {
  fail(`Unexpected error: ${(err as Error).message ?? String(err)}`);
  if (process.env.DEBUG) {
    console.error(err);
  }
  process.exit(1);
});
