import { Injectable, Logger, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Not, Repository } from 'typeorm';
import { User, UserRole } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

// Roles that count towards the "at least one active admin" guarantee.
const ADMIN_ROLES = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

@Injectable()
export class UsersService {
  private readonly logger = new Logger(UsersService.name);

  constructor(
    @InjectRepository(User)
    private readonly userRepo: Repository<User>,
    private readonly dataSource: DataSource,
  ) {}

  async findById(id: string): Promise<User> {
    const user = await this.userRepo.findOne({ where: { id } });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    return user;
  }

  async findByWallet(wallet: string): Promise<User | null> {
    return this.userRepo.findOne({ where: { wallet } });
  }

  async findAll(
    page = 1,
    limit = 20,
  ): Promise<{ data: User[]; total: number; page: number; limit: number }> {
    const [data, total] = await this.userRepo.findAndCount({
      skip: (page - 1) * limit,
      take: limit,
      order: { createdAt: 'DESC' },
    });
    return { data, total, page, limit };
  }

  async updateProfile(userId: string, dto: UpdateUserDto): Promise<User> {
    const user = await this.findById(userId);
    if (dto.email !== undefined) {
      user.email = dto.email;
    }
    if (dto.displayName !== undefined) {
      user.displayName = dto.displayName;
    }
    if (dto.isKycVerified !== undefined) {
      if (user.role === UserRole.ADMIN) {
        user.isKycVerified = dto.isKycVerified;
      } else {
        throw new ForbiddenException('Only admins can update KYC status');
      }
    }
    return this.userRepo.save(user);
  }

  async updateRole(actorUserId: string, targetUserId: string, dto: UpdateRoleDto): Promise<User> {
    if (actorUserId === targetUserId) {
      throw new ForbiddenException('Admins cannot change their own role');
    }

    const user = await this.findById(targetUserId);
    const previousRole = user.role;

    if (ADMIN_ROLES.includes(previousRole) && !ADMIN_ROLES.includes(dto.role)) {
      await this.assertNotLastActiveAdmin(targetUserId);
    }

    user.role = dto.role;
    const saved = await this.userRepo.save(user);

    await this.writeAuditEvent('role_changed', actorUserId, targetUserId, {
      previousRole,
      newRole: dto.role,
    });

    return saved;
  }

  async softDelete(actorUserId: string, userId: string): Promise<void> {
    if (actorUserId === userId) {
      throw new ForbiddenException('Admins cannot deactivate their own account');
    }

    const user = await this.findById(userId);

    if (ADMIN_ROLES.includes(user.role)) {
      await this.assertNotLastActiveAdmin(userId);
    }

    const result = await this.userRepo.update(userId, { isActive: false });
    if (result.affected === 0) {
      throw new NotFoundException('User not found');
    }

    await this.writeAuditEvent('user_deactivated', actorUserId, userId, {
      role: user.role,
    });
  }

  async restore(actorUserId: string, userId: string): Promise<User> {
    const user = await this.userRepo.findOne({
      where: { id: userId },
      withDeleted: false,
    });
    if (!user) {
      throw new NotFoundException('User not found');
    }
    user.isActive = true;
    const saved = await this.userRepo.save(user);

    await this.writeAuditEvent('user_restored', actorUserId, userId, {});

    return saved;
  }

  /**
   * Guards against demoting/deactivating the last remaining active admin,
   * which would leave the platform with no one able to manage users.
   */
  private async assertNotLastActiveAdmin(excludeUserId: string): Promise<void> {
    const remainingAdmins = await this.userRepo.count({
      where: {
        role: In(ADMIN_ROLES),
        isActive: true,
        id: Not(excludeUserId),
      },
    });
    if (remainingAdmins === 0) {
      throw new ForbiddenException('Cannot remove the last active admin');
    }
  }

  /**
   * Appends a row to the user_audit_log table. Uses raw SQL so it works
   * both inside and outside transactions, consistent with GovernanceService.
   */
  private async writeAuditEvent(
    eventType: string,
    actorUserId: string,
    targetUserId: string,
    payload: Record<string, unknown>,
  ): Promise<void> {
    try {
      await this.dataSource.query(
        `INSERT INTO user_audit_log (event_type, actor_user_id, target_user_id, payload)
         VALUES ($1, $2, $3, $4::jsonb)`,
        [eventType, actorUserId, targetUserId, JSON.stringify(payload)],
      );
    } catch (err) {
      // Audit writes are best-effort — never let them fail a business operation.
      this.logger.warn(
        `Failed to write user audit event '${eventType}': ${(err as Error).message}`,
      );
    }
  }
}
