import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UsersService } from './users.service';
import { User, UserRole } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeUser(overrides: Partial<User> = {}): User {
  const user = new User();
  user.id = overrides.id ?? 'uuid-default';
  user.wallet = overrides.wallet ?? 'GABCDEF1234567890';
  user.email = overrides.email ?? null;
  user.displayName = overrides.displayName ?? null;
  user.role = overrides.role ?? UserRole.FARMER;
  user.isKycVerified = overrides.isKycVerified ?? false;
  user.isActive = overrides.isActive ?? true;
  user.refreshToken = overrides.refreshToken ?? null;
  user.createdAt = overrides.createdAt ?? new Date('2026-01-01T00:00:00Z');
  user.updatedAt = overrides.updatedAt ?? new Date('2026-01-01T00:00:00Z');
  return user;
}

type MockRepo = {
  findOne: jest.Mock;
  findAndCount: jest.Mock;
  save: jest.Mock;
  update: jest.Mock;
  count: jest.Mock;
  createQueryBuilder: jest.Mock;
};

// Chainable QueryBuilder mock covering the surface the `paginate()` helper uses.
function makeQb() {
  return {
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
  };
}

function makeRepo(): MockRepo {
  return {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
    createQueryBuilder: jest.fn(() => makeQb()),
  };
}

type MockDataSource = {
  query: jest.Mock;
};

function makeDataSource(): MockDataSource {
  return {
    query: jest.fn().mockResolvedValue(undefined),
  };
}

// ── Suite ────────────────────────────────────────────────────────────────────

describe('UsersService', () => {
  let service: UsersService;
  let repo: MockRepo;
  let dataSource: MockDataSource;

  beforeEach(async () => {
    repo = makeRepo();
    dataSource = makeDataSource();

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: getRepositoryToken(User), useValue: repo },
        { provide: DataSource, useValue: dataSource },
      ],
    }).compile();

    service = module.get<UsersService>(UsersService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── findById ──────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns a user when found', async () => {
      const user = makeUser({ id: 'uuid-1' });
      repo.findOne.mockResolvedValue(user);

      const result = await service.findById('uuid-1');
      expect(result).toEqual(user);
      expect(repo.findOne).toHaveBeenCalledWith({ where: { id: 'uuid-1' } });
    });

    it('throws NotFoundException when user does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
    });
  });

  // ── findByWallet ──────────────────────────────────────────────────────────

  describe('findByWallet', () => {
    it('returns a user when wallet exists', async () => {
      const user = makeUser({ wallet: 'GABCDEF' });
      repo.findOne.mockResolvedValue(user);

      const result = await service.findByWallet('GABCDEF');
      expect(result).toEqual(user);
      expect(repo.findOne).toHaveBeenCalledWith({ where: { wallet: 'GABCDEF' } });
    });

    it('returns null when wallet is not found', async () => {
      repo.findOne.mockResolvedValue(null);

      const result = await service.findByWallet('GUNKNOWN');
      expect(result).toBeNull();
    });
  });

  // ── findAll ───────────────────────────────────────────────────────────────

  describe('findAll', () => {
    it('returns offset-paginated results with default page/limit', async () => {
      const users = [makeUser(), makeUser()];
      const qb = makeQb();
      qb.getManyAndCount.mockResolvedValue([users, 2]);
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll();

      expect(result).toEqual({ data: users, total: 2, page: 1, limit: 20 });
      // Ordering carries the id tiebreaker so pages are a strict total order.
      expect(qb.orderBy).toHaveBeenCalledWith('user.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('user.id', 'DESC');
      expect(qb.skip).toHaveBeenCalledWith(0);
      expect(qb.take).toHaveBeenCalledWith(20);
    });

    it('respects custom page and limit', async () => {
      const users = [makeUser()];
      const qb = makeQb();
      qb.getManyAndCount.mockResolvedValue([users, 10]);
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({ page: 3, limit: 10 });

      expect(result).toEqual({ data: users, total: 10, page: 3, limit: 10 });
      expect(qb.skip).toHaveBeenCalledWith(20);
      expect(qb.take).toHaveBeenCalledWith(10);
    });

    it('returns empty array when no users exist', async () => {
      const qb = makeQb();
      qb.getManyAndCount.mockResolvedValue([[], 0]);
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll();
      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
    });

    it('uses keyset mode and returns a nextCursor when a cursor is supplied', async () => {
      // Over-fetch by one (limit + 1) signals there is another page.
      const page = [makeUser({ id: 'u1' }), makeUser({ id: 'u2' })];
      const qb = makeQb();
      qb.getMany.mockResolvedValue([...page, makeUser({ id: 'u3' })]);
      repo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({ cursor: undefined, limit: 2 });
      // No cursor → offset mode; assert the keyset branch separately below.
      expect(result.total).toBe(0);

      const qb2 = makeQb();
      qb2.getMany.mockResolvedValue([...page, makeUser({ id: 'u3' })]);
      repo.createQueryBuilder.mockReturnValue(qb2);
      const cursorResult = await service.findAll({
        cursor: Buffer.from(
          JSON.stringify({ v: new Date('2026-01-01T00:00:00Z').toISOString(), id: 'seed' }),
        ).toString('base64url'),
        limit: 2,
      });

      expect(cursorResult.data).toHaveLength(2);
      expect(cursorResult.hasMore).toBe(true);
      expect(cursorResult.nextCursor).toBeTruthy();
      expect(cursorResult.total).toBeUndefined();
      // Keyset mode seeks, it never uses OFFSET.
      expect(qb2.skip).not.toHaveBeenCalled();
      expect(qb2.take).toHaveBeenCalledWith(3);
    });
  });

  // ── countEligible ───────────────────────────────────────────────────────────

  describe('countEligible', () => {
    it('counts only active, KYC-verified users (the governance quorum denominator)', async () => {
      repo.count.mockResolvedValue(42);

      const result = await service.countEligible();

      expect(result).toBe(42);
      expect(repo.count).toHaveBeenCalledWith({
        where: { isActive: true, isKycVerified: true },
      });
    });

    it('returns 0 during bootstrap when no user is eligible yet', async () => {
      repo.count.mockResolvedValue(0);
      await expect(service.countEligible()).resolves.toBe(0);
    });
  });

  // ── updateProfile ─────────────────────────────────────────────────────────

  describe('updateProfile', () => {
    it('updates email', async () => {
      const user = makeUser({ email: null });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, email: 'new@example.com' });

      const dto: UpdateUserDto = { email: 'new@example.com' };
      const result = await service.updateProfile(user.id, dto);

      expect(result.email).toBe('new@example.com');
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('updates displayName', async () => {
      const user = makeUser({ displayName: null });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, displayName: 'Alice' });

      const dto: UpdateUserDto = { displayName: 'Alice' };
      const result = await service.updateProfile(user.id, dto);

      expect(result.displayName).toBe('Alice');
    });

    it('updates isKycVerified only via the admin KYC endpoint, never through updateProfile', async () => {
      const user = makeUser({ role: UserRole.FARMER, isKycVerified: false });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockImplementation((u) => Promise.resolve(u));

      const dto: UpdateUserDto = { displayName: 'No KYC here' };
      const result = await service.updateProfile(user.id, dto);

      expect(result.isKycVerified).toBe(false);
    });

    it('applies partial updates without affecting other fields', async () => {
      const user = makeUser({ email: 'old@example.com', displayName: 'Old Name' });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockImplementation((u) => Promise.resolve(u));

      const dto: UpdateUserDto = { displayName: 'New Name' };
      const result = await service.updateProfile(user.id, dto);

      expect(result.displayName).toBe('New Name');
      expect(result.email).toBe('old@example.com');
    });

    it('throws NotFoundException when user does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      const dto: UpdateUserDto = { email: 'test@test.com' };
      await expect(service.updateProfile('no-such-id', dto)).rejects.toThrow(NotFoundException);
    });

    it('never touches isKycVerified even for admin callers', async () => {
      const user = makeUser({ role: UserRole.ADMIN, isKycVerified: false });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockImplementation((u) => Promise.resolve(u));

      const dto: UpdateUserDto = { displayName: 'Admin Self' };
      const result = await service.updateProfile(user.id, dto);

      expect(result.isKycVerified).toBe(false);
    });
  });

  // ── updateKycStatus ───────────────────────────────────────────────────────

  describe('updateKycStatus', () => {
    it('allows an admin to set KYC status on another user', async () => {
      const target = makeUser({ id: 'uuid-target', role: UserRole.FARMER, isKycVerified: false });
      repo.findOne.mockResolvedValue(target);
      repo.save.mockImplementation((u) => Promise.resolve(u));

      const dto: AdminUpdateUserDto = { isKycVerified: true };
      const result = await service.updateKycStatus('actor-1', 'uuid-target', dto);

      expect(result.isKycVerified).toBe(true);
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('allows an admin to revoke KYC status (set to false)', async () => {
      const target = makeUser({ id: 'uuid-target', role: UserRole.FARMER, isKycVerified: true });
      repo.findOne.mockResolvedValue(target);
      repo.save.mockImplementation((u) => Promise.resolve(u));

      const dto: AdminUpdateUserDto = { isKycVerified: false };
      const result = await service.updateKycStatus('actor-1', 'uuid-target', dto);

      expect(result.isKycVerified).toBe(false);
    });

    it('throws ForbiddenException when an admin targets their own id (self-KYC)', async () => {
      const dto: AdminUpdateUserDto = { isKycVerified: true };

      await expect(service.updateKycStatus('actor-1', 'actor-1', dto)).rejects.toThrow(
        ForbiddenException,
      );
      await expect(service.updateKycStatus('actor-1', 'actor-1', dto)).rejects.toThrow(
        'Admins cannot update their own KYC status',
      );
      expect(repo.findOne).not.toHaveBeenCalled();
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when the target user does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      const dto: AdminUpdateUserDto = { isKycVerified: true };
      await expect(service.updateKycStatus('actor-1', 'no-such-id', dto)).rejects.toThrow(
        NotFoundException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('writes an audit event with previous and new KYC values', async () => {
      const target = makeUser({ id: 'uuid-1', role: UserRole.FARMER, isKycVerified: false });
      repo.findOne.mockResolvedValue(target);
      repo.save.mockImplementation((u) => Promise.resolve(u));

      const dto: AdminUpdateUserDto = { isKycVerified: true };
      await service.updateKycStatus('actor-1', 'uuid-1', dto);

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_audit_log'),
        [
          'kyc_status_changed',
          'actor-1',
          'uuid-1',
          JSON.stringify({
            previousKycVerified: false,
            newKycVerified: true,
          }),
        ],
      );
    });
  });

  // ── updateRole ────────────────────────────────────────────────────────────

  describe('updateRole', () => {
    it('updates the role of a user', async () => {
      const user = makeUser({ role: UserRole.FARMER });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, role: UserRole.ADMIN });

      const dto: UpdateRoleDto = { role: UserRole.ADMIN };
      const result = await service.updateRole('actor-1', user.id, dto);

      expect(result.role).toBe(UserRole.ADMIN);
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when target user does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      const dto: UpdateRoleDto = { role: UserRole.ORACLE };
      await expect(service.updateRole('actor-1', 'no-such-id', dto)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('writes an audit event with actor, previous role and new role', async () => {
      const user = makeUser({ id: 'uuid-1', role: UserRole.FARMER });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, role: UserRole.ORACLE });

      const dto: UpdateRoleDto = { role: UserRole.ORACLE };
      await service.updateRole('actor-1', 'uuid-1', dto);

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_audit_log'),
        [
          'role_changed',
          'actor-1',
          'uuid-1',
          JSON.stringify({
            previousRole: UserRole.FARMER,
            newRole: UserRole.ORACLE,
          }),
        ],
      );
    });

    it('throws ForbiddenException when an admin tries to change their own role', async () => {
      const dto: UpdateRoleDto = { role: UserRole.FARMER };

      await expect(service.updateRole('actor-1', 'actor-1', dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when demoting the last active admin', async () => {
      const user = makeUser({ id: 'uuid-1', role: UserRole.ADMIN });
      repo.findOne.mockResolvedValue(user);
      repo.count.mockResolvedValue(0);

      const dto: UpdateRoleDto = { role: UserRole.FARMER };
      await expect(service.updateRole('actor-1', 'uuid-1', dto)).rejects.toThrow(
        ForbiddenException,
      );
      expect(repo.save).not.toHaveBeenCalled();
    });

    it('allows demoting an admin when other active admins remain', async () => {
      const user = makeUser({ id: 'uuid-1', role: UserRole.ADMIN });
      repo.findOne.mockResolvedValue(user);
      repo.count.mockResolvedValue(1);
      repo.save.mockResolvedValue({ ...user, role: UserRole.FARMER });

      const dto: UpdateRoleDto = { role: UserRole.FARMER };
      const result = await service.updateRole('actor-1', 'uuid-1', dto);

      expect(result.role).toBe(UserRole.FARMER);
    });

    it('does not check admin count when the role stays within the admin tier', async () => {
      const user = makeUser({ id: 'uuid-1', role: UserRole.ADMIN });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, role: UserRole.SUPER_ADMIN });

      const dto: UpdateRoleDto = { role: UserRole.SUPER_ADMIN };
      await service.updateRole('actor-1', 'uuid-1', dto);

      expect(repo.count).not.toHaveBeenCalled();
    });
  });

  // ── softDelete ────────────────────────────────────────────────────────────

  describe('softDelete', () => {
    it('sets isActive to false and returns void', async () => {
      const user = makeUser({ id: 'uuid-1', role: UserRole.FARMER });
      repo.findOne.mockResolvedValue(user);
      repo.update.mockResolvedValue({ affected: 1, raw: {}, generatedMaps: [] });

      await service.softDelete('actor-1', 'uuid-1');
      expect(repo.update).toHaveBeenCalledWith('uuid-1', { isActive: false });
    });

    it('throws NotFoundException when the target user does not exist', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.softDelete('actor-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('throws ForbiddenException when an admin tries to deactivate themselves', async () => {
      await expect(service.softDelete('actor-1', 'actor-1')).rejects.toThrow(ForbiddenException);
      expect(repo.findOne).not.toHaveBeenCalled();
    });

    it('throws ForbiddenException when deactivating the last active admin', async () => {
      const user = makeUser({ id: 'uuid-1', role: UserRole.SUPER_ADMIN });
      repo.findOne.mockResolvedValue(user);
      repo.count.mockResolvedValue(0);

      await expect(service.softDelete('actor-1', 'uuid-1')).rejects.toThrow(ForbiddenException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('writes an audit event on successful deactivation', async () => {
      const user = makeUser({ id: 'uuid-1', role: UserRole.FARMER });
      repo.findOne.mockResolvedValue(user);
      repo.update.mockResolvedValue({ affected: 1, raw: {}, generatedMaps: [] });

      await service.softDelete('actor-1', 'uuid-1');

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_audit_log'),
        ['user_deactivated', 'actor-1', 'uuid-1', JSON.stringify({ role: UserRole.FARMER })],
      );
    });
  });

  // ── restore ───────────────────────────────────────────────────────────────

  describe('restore', () => {
    it('sets isActive to true on the found user', async () => {
      const user = makeUser({ id: 'uuid-1', isActive: false });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, isActive: true });

      const result = await service.restore('actor-1', 'uuid-1');
      expect(result.isActive).toBe(true);
      expect(repo.findOne).toHaveBeenCalledWith({
        where: { id: 'uuid-1' },
        withDeleted: false,
      });
      expect(repo.save).toHaveBeenCalledTimes(1);
    });

    it('throws NotFoundException when user is not found', async () => {
      repo.findOne.mockResolvedValue(null);

      await expect(service.restore('actor-1', 'nonexistent')).rejects.toThrow(NotFoundException);
    });

    it('writes an audit event on successful restore', async () => {
      const user = makeUser({ id: 'uuid-1', isActive: false });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, isActive: true });

      await service.restore('actor-1', 'uuid-1');

      expect(dataSource.query).toHaveBeenCalledWith(
        expect.stringContaining('INSERT INTO user_audit_log'),
        ['user_restored', 'actor-1', 'uuid-1', JSON.stringify({})],
      );
    });
  });
});
