import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum ProposalStatus {
  ACTIVE = 'active',
  PASSED = 'passed',
  REJECTED = 'rejected',
  EXECUTED = 'executed',
  EXPIRED = 'expired',
}

@Entity('proposals')
// Composite indexes backing keyset (created_at, id) pagination of
// GET /governance/proposals and its status filter variant.
@Index('idx_proposals_created_at_id', ['createdAt', 'id'])
@Index('idx_proposals_status_created_at_id', ['status', 'createdAt', 'id'])
export class Proposal {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 56 })
  @Index()
  proposer: string;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'action_type', type: 'varchar', length: 50 })
  actionType: string;

  @Column({ name: 'action_params', type: 'jsonb', nullable: true })
  actionParams: Record<string, unknown> | null;

  @Column({ name: 'votes_for', type: 'bigint', default: 0 })
  votesFor: number;

  @Column({ name: 'votes_against', type: 'bigint', default: 0 })
  votesAgainst: number;

  @Column({ type: 'enum', enum: ProposalStatus, default: ProposalStatus.ACTIVE })
  status: ProposalStatus;

  @Column({ type: 'timestamptz' })
  deadline: Date;

  /**
   * Numeric identifier used by the on-chain Soroban governance contract.
   * Populated after the proposal is executed on-chain (u32 from the contract).
   * NULL until execution is confirmed.
   */
  @Column({ name: 'on_chain_proposal_id', type: 'int', nullable: true })
  onChainProposalId: number | null;

  /** Stellar transaction hash from the on-chain execute() call. */
  @Column({ name: 'execution_tx_hash', type: 'varchar', length: 100, nullable: true })
  executionTxHash: string | null;

  /** Wallet address of the admin who triggered executeProposal(). */
  @Column({ name: 'executed_by', type: 'varchar', length: 56, nullable: true })
  executedBy: string | null;

  /** Timestamp at which execution was confirmed on-chain. */
  @Column({ name: 'executed_at', type: 'timestamptz', nullable: true })
  executedAt: Date | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
