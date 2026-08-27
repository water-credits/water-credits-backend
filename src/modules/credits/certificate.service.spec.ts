import { CertificateService } from './certificate.service';
import { Retirement } from './entities/retirement.entity';

function makeRetirement(): Retirement {
  return {
    id: 'ret-1',
    userId: 'user-1',
    projectId: 'proj-1',
    amount: 250,
    purpose: 'watershed restoration',
    metadataUri: 'https://example.com/meta',
    txHash: 'tx-real-123',
    certificateIpfsUri: null,
    retiredAt: new Date('2026-03-15T12:00:00Z'),
    createdAt: new Date(),
    user: undefined as never,
    project: undefined as never,
  };
}

describe('CertificateService', () => {
  let service: CertificateService;
  let dataSourceQuery: jest.Mock;
  let projectRepo: { findOne: jest.Mock };
  let userRepo: { findOne: jest.Mock };
  let configGet: jest.Mock;

  beforeEach(() => {
    dataSourceQuery = jest.fn().mockImplementation((sql: string) => {
      if (sql.includes('nextval')) {
        return Promise.resolve([{ val: 10001 }]);
      }
      return Promise.resolve([]);
    });
    projectRepo = { findOne: jest.fn().mockResolvedValue({ name: 'Blue River' }) };
    userRepo = { findOne: jest.fn().mockResolvedValue({ wallet: 'GABC123' }) };
    configGet = jest.fn().mockReturnValue('');

    service = new CertificateService(
      { query: dataSourceQuery } as never,
      projectRepo as never,
      userRepo as never,
      { get: configGet } as never,
    );
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('generates a WQC certificate number and uploads to Infura on success', async () => {
    configGet.mockImplementation((key: string) => {
      if (key === 'ipfs.apiUrl') {
        return 'https://ipfs.infura.io:5001';
      }
      if (key === 'ipfs.projectId') {
        return 'pid';
      }
      if (key === 'ipfs.projectSecret') {
        return 'psecret';
      }
      return '';
    });

    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ Hash: 'bafycert' }),
    });
    global.fetch = fetchMock as never;

    const uri = await service.uploadRetirementCertificate(makeRetirement());

    expect(uri).toBe('ipfs://bafycert');
    expect(dataSourceQuery).toHaveBeenCalledWith(
      'CREATE SEQUENCE IF NOT EXISTS certificate_number_seq START WITH 1',
    );
    expect(dataSourceQuery).toHaveBeenCalledWith(
      "SELECT nextval('certificate_number_seq')::bigint AS val",
    );

    const form = fetchMock.mock.calls[0][1].body as FormData;
    const file = form.get('file') as Blob;
    const body = JSON.parse(await file.text());
    // value 10001 -> block 1, serial 1 -> WQC-2026-001-0001
    expect(body.certificateNumber).toBe('WQC-2026-001-0001');
    expect(body.projectName).toBe('Blue River');
    expect(body.retireeWallet).toBe('GABC123');
    expect(body.txHash).toBe('tx-real-123');
    expect(body.amount).toBe(250);
    expect(body.purpose).toBe('watershed restoration');
  });

  it('returns null (and does not throw) when no IPFS provider is configured', async () => {
    configGet.mockReturnValue('');

    const uri = await service.uploadRetirementCertificate(makeRetirement());

    expect(uri).toBeNull();
  });

  it('falls back to Pinata when Infura fails and a JWT is set', async () => {
    configGet.mockImplementation((key: string) => {
      if (key === 'ipfs.apiUrl') {
        return 'https://ipfs.infura.io:5001';
      }
      if (key === 'ipfs.projectId') {
        return 'pid';
      }
      if (key === 'ipfs.projectSecret') {
        return 'psecret';
      }
      if (key === 'ipfs.pinataJwt') {
        return 'pinata-jwt';
      }
      return '';
    });

    const fetchMock = jest
      .fn()
      .mockResolvedValueOnce({ ok: false, status: 500, text: async () => 'boom' })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ IpfsHash: 'bafypin' }),
      });
    global.fetch = fetchMock as never;

    const uri = await service.uploadRetirementCertificate(makeRetirement());

    expect(uri).toBe('ipfs://bafypin');
    // First call = Infura, second = Pinata fallback.
    expect(fetchMock.mock.calls[0][0]).toContain('/api/v0/add');
    expect(fetchMock.mock.calls[1][0]).toContain('pinata.cloud');
  });
});
