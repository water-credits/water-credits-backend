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

export enum NotificationType {
  SENSOR_READING = 'sensor:reading',
  SENSOR_ALERT = 'sensor:alert',
  CREDIT_MINTED = 'credit:minted',
  CREDIT_RETIRED = 'credit:retired',
  ORACLE_STATUS = 'oracle:status',
  ORACLE_SUBMITTED = 'oracle:submitted',
  GOVERNANCE_PROPOSAL = 'governance:proposal',
  GOVERNANCE_VOTE = 'governance:vote',
}

@Entity('notifications')
// Composite index backing keyset (created_at, id) pagination of
// GET /notifications, which is always scoped to the caller's user_id.
@Index('idx_notifications_user_created_at_id', ['userId', 'createdAt', 'id'])
export class Notification {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id' })
  @Index()
  userId: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'user_id' })
  user: User;

  @Column({ type: 'enum', enum: NotificationType })
  type: NotificationType;

  @Column({ type: 'varchar', length: 255 })
  title: string;

  @Column({ type: 'text' })
  message: string;

  @Column({ type: 'jsonb', nullable: true })
  metadata: Record<string, unknown> | null;

  @Column({ name: 'is_read', type: 'boolean', default: false })
  isRead: boolean;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
