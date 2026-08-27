import { Entity, PrimaryGeneratedColumn, Column, UpdateDateColumn, Check } from 'typeorm';

/**
 * Protocol config is a singleton: exactly one row, always id = 1.
 * The CHECK constraint below (combined with the primary key on `id`) makes
 * that a hard database guarantee instead of an application-level assumption
 * — see GovernanceService.getConfig() for the matching race-free upsert and
 * migration 016_governance_config_singleton.sql for how existing databases
 * are reconciled onto it.
 */
@Entity('governance_config')
@Check('governance_config_singleton_id', '"id" = 1')
export class GovernanceConfig {
  @PrimaryGeneratedColumn()
  id: number;

  @Column({ name: 'protocol_fee_bps', type: 'int', default: 100 })
  protocolFeeBps: number;

  @Column({ name: 'min_oracle_confirmations', type: 'int', default: 3 })
  minOracleConfirmations: number;

  @Column({ name: 'voting_period', type: 'int', default: 604800 })
  votingPeriod: number;

  @Column({ name: 'timelock_period', type: 'int', default: 86400 })
  timelockPeriod: number;

  /**
   * Legacy absolute quorum: the minimum number of votes cast for a proposal to
   * be decided. Retained as a fallback and used only when percentage-based
   * quorum cannot apply — that is, when `quorumBasisPoints` is 0 (model
   * disabled) or the eligible-voter population is 0 (bootstrap period). See
   * `quorumBasisPoints` and GovernanceService's quorum evaluation.
   */
  @Column({ type: 'int', default: 3 })
  quorum: number;

  /**
   * Percentage-of-eligible-voters quorum, in basis points (10000 = 100%).
   * Default 2000 = 20%. A proposal reaches quorum when turnout
   * (votes_for + votes_against) is at least this share of the eligible-voter
   * population (active, KYC-verified users) at evaluation time.
   *
   * Set to 0 to disable the percentage model and fall back to the absolute
   * `quorum` integer. Stored as SMALLINT since basis points never exceed 10000.
   */
  @Column({ name: 'quorum_basis_points', type: 'smallint', default: 2000 })
  quorumBasisPoints: number;

  // ── Water-quality thresholds (used by oracle scoring) ──

  @Column({ name: 'ph_min', type: 'numeric', precision: 5, scale: 2, nullable: true })
  phMin: number | null;

  @Column({ name: 'ph_max', type: 'numeric', precision: 5, scale: 2, nullable: true })
  phMax: number | null;

  @Column({ name: 'do_threshold', type: 'numeric', precision: 5, scale: 2, nullable: true })
  doThreshold: number | null;

  @Column({ name: 'temp_penalty_delta', type: 'numeric', precision: 5, scale: 2, nullable: true })
  tempPenaltyDelta: number | null;

  // ── Credit-weight parameters ──

  @Column({ name: 'weight_volumetric', type: 'numeric', precision: 5, scale: 4, default: 0.5 })
  weightVolumetric: number;

  @Column({ name: 'weight_nitrogen', type: 'numeric', precision: 5, scale: 4, default: 0.3 })
  weightNitrogen: number;

  @Column({ name: 'weight_phosphorus', type: 'numeric', precision: 5, scale: 4, default: 0.2 })
  weightPhosphorus: number;

  @Column({ name: 'updated_by', type: 'varchar', length: 56, nullable: true })
  updatedBy: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
