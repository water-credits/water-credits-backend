import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { Repository } from 'typeorm';
import { ConfigService } from '@nestjs/config';
import { Retirement } from './entities/retirement.entity';
import { Project } from '../projects/entities/project.entity';
import { User } from '../users/entities/user.entity';

/**
 * Structured retirement certificate pinned to IPFS.
 *
 * The document is JSON-only for v0.2 (PDF rendering is out of scope).  It is
 * the source of truth referenced by the on-chain retirement and surfaced by
 * GET /credits/retirements/:id/certificate.
 */
export interface RetirementCertificate {
  certificateNumber: string;
  retirementId: string;
  projectName: string;
  amount: number;
  purpose: string;
  retireeWallet: string | null;
  txHash: string;
  retiredAt: string;
  metadataUri: string | null;
  issuedAt: string;
}

@Injectable()
export class CertificateService {
  private readonly logger = new Logger(CertificateService.name);

  constructor(
    private readonly dataSource: DataSource,
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly configService: ConfigService,
  ) {}

  /**
   * Builds the certificate document, uploads it to IPFS, and returns the
   * resulting `ipfs://` URI.
   *
   * Failures are caught, logged, and turned into `null` so the caller (the
   * retirement processor) can safely treat certificate upload as best-effort:
   * a failed upload must never roll back the on-chain confirmation.
   */
  async uploadRetirementCertificate(retirement: Retirement): Promise<string | null> {
    try {
      const certificateNumber = await this.generateCertificateNumber(retirement);

      const [project, user] = await Promise.all([
        this.projectRepo.findOne({ where: { id: retirement.projectId } }),
        this.userRepo.findOne({ where: { id: retirement.userId } }),
      ]);

      const document: RetirementCertificate = {
        certificateNumber,
        retirementId: retirement.id,
        projectName: project?.name ?? 'Unknown project',
        amount: Number(retirement.amount),
        purpose: retirement.purpose,
        retireeWallet: user?.wallet ?? null,
        txHash: retirement.txHash,
        retiredAt: retirement.retiredAt.toISOString(),
        metadataUri: retirement.metadataUri,
        issuedAt: new Date().toISOString(),
      };

      const uri = await this.uploadToIpfs(document);
      this.logger.log(
        `Certificate ${certificateNumber} for retirement ${retirement.id} pinned at ${uri}`,
      );
      return uri;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(`Failed to upload certificate for retirement ${retirement.id}: ${message}`);
      return null;
    }
  }

  /**
   * Generates a globally monotonic, collision-free certificate number of the
   * form `WQC-YYYY-NNN-NNNN`.
   *
   * A Postgres sequence guarantees uniqueness even under Bull's concurrency-2
   * processor: each caller obtains a distinct `nextval`. The sequence value is
   * split into a year block (NNN) and serial (NNNN) for human-readable
   * grouping while remaining strictly increasing.
   */
  private async generateCertificateNumber(retirement: Retirement): Promise<string> {
    await this.dataSource.query(
      'CREATE SEQUENCE IF NOT EXISTS certificate_number_seq START WITH 1',
    );

    const rows = await this.dataSource.query(
      "SELECT nextval('certificate_number_seq')::bigint AS val",
    );
    const value: number = Number(rows[0].val);

    const year = retirement.retiredAt.getFullYear();
    const block = Math.floor(value / 10000); // NNN
    const serial = value % 10000; // NNNN

    return `WQC-${year}-${String(block).padStart(3, '0')}-${String(serial).padStart(4, '0')}`;
  }

  /**
   * Uploads the certificate JSON to IPFS.  Infura is used when credentials are
   * present; if Infura fails (or is unconfigured) and a Pinata JWT is set, the
   * upload falls back to Pinata.  Throws if no provider succeeds.
   */
  private async uploadToIpfs(document: RetirementCertificate): Promise<string> {
    const apiUrl = this.configService.get<string>('ipfs.apiUrl') || 'https://ipfs.infura.io:5001';
    const projectId = this.configService.get<string>('ipfs.projectId');
    const projectSecret = this.configService.get<string>('ipfs.projectSecret');
    const pinataJwt = this.configService.get<string>('ipfs.pinataJwt');

    if (projectId && projectSecret) {
      try {
        return await this.uploadToInfura(apiUrl, projectId, projectSecret, document);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.logger.warn(`Infura IPFS upload failed, attempting fallback: ${message}`);
      }
    }

    if (pinataJwt) {
      return await this.uploadToPinata(pinataJwt, document);
    }

    throw new Error('No IPFS provider configured (set Infura or Pinata credentials)');
  }

  private async uploadToInfura(
    apiUrl: string,
    projectId: string,
    projectSecret: string,
    document: RetirementCertificate,
  ): Promise<string> {
    const form = new FormData();
    const blob = new Blob([JSON.stringify(document, null, 2)], {
      type: 'application/json',
    });
    form.append('file', blob, `certificate-${document.certificateNumber}.json`);

    const auth = Buffer.from(`${projectId}:${projectSecret}`).toString('base64');

    const response = await fetch(`${apiUrl}/api/v0/add?pin=true`, {
      method: 'POST',
      headers: { Authorization: `Basic ${auth}` },
      body: form,
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Infura responded ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { Hash?: string };
    if (!data.Hash) {
      throw new Error('Infura response missing Hash');
    }

    return `ipfs://${data.Hash}`;
  }

  private async uploadToPinata(
    pinataJwt: string,
    document: RetirementCertificate,
  ): Promise<string> {
    const response = await fetch('https://api.pinata.cloud/pinning/pinJSONToIPFS', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${pinataJwt}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ pinataContent: document }),
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Pinata responded ${response.status}: ${body}`);
    }

    const data = (await response.json()) as { IpfsHash?: string };
    if (!data.IpfsHash) {
      throw new Error('Pinata response missing IpfsHash');
    }

    return `ipfs://${data.IpfsHash}`;
  }
}
