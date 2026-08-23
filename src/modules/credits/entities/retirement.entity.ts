import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { User } from '../../users/entities/user.entity';
import { Project } from '../../projects/entities/project.entity';

@Entity('retirements')
// Composite index backing keyset (retired_at, id) pagination of
// GET /credits/retirements, which is always scoped to the caller's user_id.
@Index('idx_retirements_user_retired_at_id', ['userId', 'retiredAt', 'id'])
export class Retirement {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ name: 'project_id' })
  @Index()
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ type: 'decimal', precision: 20, scale: 6 })
  amount: number;

  @Column({ type: 'varchar', length: 255 })
  purpose: string;

  @Column({ name: 'metadata_uri', type: 'varchar', length: 255, nullable: true })
  metadataUri: string | null;

  @Column({ name: 'tx_hash', type: 'varchar', length: 100 })
  txHash: string;

  @Column({ name: 'certificate_ipfs_uri', type: 'varchar', length: 255, nullable: true })
  certificateIpfsUri: string | null;

  @Column({ name: 'retired_at', type: 'timestamptz' })
  retiredAt: Date;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
