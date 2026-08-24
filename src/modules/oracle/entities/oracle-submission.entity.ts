import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Project } from '../../projects/entities/project.entity';
import { ReadingBatch } from '../../sensors/entities/reading-batch.entity';

export enum SubmissionStatus {
  PENDING = 'pending',
  SUBMITTED = 'submitted',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

@Entity('oracle_submissions')
@Unique(['projectId', 'oracleAddress', 'nonce'])
// Composite indexes backing keyset (created_at, id) pagination of
// GET /oracle/submissions, including its project/status filter variants.
@Index('idx_oracle_submissions_created_at_id', ['createdAt', 'id'])
@Index('idx_oracle_submissions_project_created_at_id', ['projectId', 'createdAt', 'id'])
@Index('idx_oracle_submissions_status_created_at_id', ['status', 'createdAt', 'id'])
export class OracleSubmission {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'project_id' })
  @Index()
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ name: 'batch_id', type: 'uuid', nullable: true })
  @Index()
  batchId: string | null;

  @ManyToOne(() => ReadingBatch, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'batch_id' })
  batch: ReadingBatch | null;

  @Column({ name: 'oracle_address', type: 'varchar', length: 56 })
  oracleAddress: string;

  @Column({ type: 'int' })
  nonce: number;

  @Column({ name: 'tx_hash', type: 'varchar', length: 100 })
  txHash: string;

  @Column({ type: 'enum', enum: SubmissionStatus, default: SubmissionStatus.PENDING })
  status: SubmissionStatus;

  @Column({ name: 'readings_snapshot', type: 'jsonb' })
  readingsSnapshot: Record<string, unknown>;

  @Column({ type: 'jsonb', nullable: true })
  result: Record<string, unknown> | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
