import { Test, TestingModule } from '@nestjs/testing';
import { NotFoundException, ForbiddenException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { UsersService } from './users.service';
import { User, UserRole } from './entities/user.entity';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRoleDto } from './dto/update-role.dto';

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
};

function makeRepo(): MockRepo {
  return {
    findOne: jest.fn(),
    findAndCount: jest.fn(),
    save: jest.fn(),
    update: jest.fn(),
    count: jest.fn(),
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
    it('returns paginated results with default page/limit', async () => {
      const users = [makeUser(), makeUser()];
      repo.findAndCount.mockResolvedValue([users, 2]);

      const result = await service.findAll();
      expect(result).toEqual({ data: users, total: 2, page: 1, limit: 20 });
      expect(repo.findAndCount).toHaveBeenCalledWith({
        skip: 0,
        take: 20,
        order: { createdAt: 'DESC' },
      });
    });

    it('respects custom page and limit', async () => {
      const users = [makeUser()];
      repo.findAndCount.mockResolvedValue([users, 10]);

      const result = await service.findAll(3, 10);
      expect(result).toEqual({ data: users, total: 10, page: 3, limit: 10 });
      expect(repo.findAndCount).toHaveBeenCalledWith({
        skip: 20,
        take: 10,
        order: { createdAt: 'DESC' },
      });
    });

    it('returns empty array when no users exist', async () => {
      repo.findAndCount.mockResolvedValue([[], 0]);

      const result = await service.findAll();
      expect(result).toEqual({ data: [], total: 0, page: 1, limit: 20 });
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

    it('updates isKycVerified when user is an admin', async () => {
      const user = makeUser({ role: UserRole.ADMIN, isKycVerified: false });
      repo.findOne.mockResolvedValue(user);
      repo.save.mockResolvedValue({ ...user, isKycVerified: true });

      const dto: UpdateUserDto = { isKycVerified: true };
      const result = await service.updateProfile(user.id, dto);

      expect(result.isKycVerified).toBe(true);
    });

    it('throws ForbiddenException when non-admin tries to update KYC', async () => {
      const user = makeUser({ role: UserRole.FARMER, isKycVerified: false });
      repo.findOne.mockResolvedValue(user);

      const dto: UpdateUserDto = { isKycVerified: true };
      await expect(service.updateProfile(user.id, dto)).rejects.toThrow(ForbiddenException);
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
