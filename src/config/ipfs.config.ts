import { registerAs } from '@nestjs/config';

export default registerAs('ipfs', () => ({
  // Infura IPFS API base URL (the v0/add endpoint is appended at request time).
  apiUrl: process.env.IPFS_API_URL || 'https://ipfs.infura.io:5001',
  projectId: process.env.IPFS_PROJECT_ID || '',
  projectSecret: process.env.IPFS_PROJECT_SECRET || '',
  // Optional Pinata fallback (used only if Infura credentials are absent or fail).
  pinataJwt: process.env.IPFS_PINATA_JWT || '',
}));
