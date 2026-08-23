import { registerAs } from '@nestjs/config';

export default registerAs('stellar', () => ({
  network: process.env.STELLAR_NETWORK || 'testnet',
  horizonUrl: process.env.STELLAR_HORIZON_URL || 'https://horizon-testnet.stellar.org',
  rpcUrl: process.env.STELLAR_RPC_URL || 'https://soroban-testnet.stellar.org',
  passphrase: process.env.STELLAR_PASSPHRASE || 'Test SDF Network ; September 2015',
  backendSecret: process.env.STELLAR_BACKEND_SECRET || 'SDN...TODO',
  simulationSecret: process.env.STELLAR_SIMULATION_SECRET || '',
  // When true, refuse to boot if STELLAR_BACKEND_SECRET is missing/placeholder/invalid.
  // Recommended for production. Default false so local/dev still starts.
  requireSigningKey: process.env.STELLAR_REQUIRE_SIGNING_KEY === 'true',
  // ── Contract addresses ──────────────────────────────────────────────────
  contractGovernance: process.env.CONTRACT_GOVERNANCE || '',
}));
