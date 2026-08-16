import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { GovernanceConfig } from './governance-config.entity';

export enum ConfigChangeStatus {
  PENDING = 'pending',
  APPLIED = 'applied',
  CANCELLED = 'cancelled',
  EMERGENCY = 'emergency',
}

@Entity('governance_config_changes')
@Index(['status', 'effectiveAt']) // used by the scheduler query
export class GovernanceConfigChange {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  /** Which config row this change targets. */
  @Column({ name: 'config_id', type: 'int' })
  configId: number;

  @ManyToOne(() => GovernanceConfig, { onDelete: 'CASCADE', eager: false })
  @JoinColumn({ name: 'config_id' })
  config: GovernanceConfig;

  /**
   * The subset of GovernanceConfig fields being changed, e.g.
   *   { "protocolFeeBps": 150, "minOracleConfirmations": 4 }
   * Only keys present in this object are written on apply.
   */
  @Column({ name: 'proposed_values', type: 'jsonb' })
  proposedValues: Partial<Omit<GovernanceConfig, 'id' | 'updatedAt' | 'updatedBy'>>;

  /** Stellar wallet of the admin who submitted this change. */
  @Index()
  @Column({ name: 'proposed_by', type: 'varchar', length: 56 })
  proposedBy: string;

  /** Time at which this change becomes eligible to be applied. */
  @Column({ name: 'effective_at', type: 'timestamptz' })
  effectiveAt: Date;

  @Column({
    type: 'varchar',
    length: 20,
    default: ConfigChangeStatus.PENDING,
  })
  status: ConfigChangeStatus;

  /** Set when the change transitions to APPLIED or EMERGENCY. */
  @Column({ name: 'applied_at', type: 'timestamptz', nullable: true })
  appliedAt: Date | null;

  @Column({ name: 'applied_by', type: 'varchar', length: 56, nullable: true })
  appliedBy: string | null;

  /** Set when the change transitions to CANCELLED. */
  @Column({ name: 'cancelled_at', type: 'timestamptz', nullable: true })
  cancelledAt: Date | null;

  @Column({ name: 'cancelled_by', type: 'varchar', length: 56, nullable: true })
  cancelledBy: string | null;

  /** Optional human-readable note from the proposer. */
  @Column({ type: 'text', nullable: true })
  reason: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
