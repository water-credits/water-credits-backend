import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Index,
} from 'typeorm';

export enum UserRole {
  SUPER_ADMIN = 'super_admin',
  ADMIN = 'admin',
  PROJECT_OWNER = 'project_owner',
  ORACLE = 'oracle',
  VERIFIER = 'verifier',
  FARMER = 'farmer',
}

@Entity('users')
// Composite index backing keyset (created_at, id) pagination of GET /users.
@Index('idx_users_created_at_id', ['createdAt', 'id'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Index({ unique: true })
  @Column({ type: 'varchar', length: 56 })
  wallet: string;

  @Column({ type: 'varchar', length: 255, nullable: true })
  email: string | null;

  @Column({ type: 'varchar', length: 100, nullable: true })
  displayName: string | null;

  @Column({ type: 'enum', enum: UserRole, default: UserRole.FARMER })
  role: UserRole;

  @Column({ name: 'is_kyc_verified', default: false })
  isKycVerified: boolean;

  @Column({ name: 'is_active', default: true })
  isActive: boolean;

  @Column({ name: 'refresh_token', type: 'text', nullable: true, select: false })
  /**
   * Stores SHA-256 HMAC of the refresh token (never the raw JWT).
   * Load explicitly with addSelect('user.refreshToken').
   */
  refreshToken: string | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
