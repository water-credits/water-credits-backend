import { Test, TestingModule } from '@nestjs/testing';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { User, UserRole } from './entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
describe('UsersController', () => {
  let controller: UsersController;
  let service: jest.Mocked<UsersService>;

  const mockUser: User = {
    id: 'user-1',
    wallet: 'GABC123',
    email: 'test@example.com',
    displayName: 'Test User',
    role: UserRole.FARMER,
    isKycVerified: false,
    isActive: true,
    refreshToken: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        {
          provide: UsersService,
          useValue: {
            updateProfile: jest.fn(),
            findAll: jest.fn(),
            updateRole: jest.fn(),
            softDelete: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<UsersController>(UsersController);
    service = module.get(UsersService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('getProfile', () => {
    it('should return the current user from @CurrentUser() without calling the service', async () => {
      const result = await controller.getProfile(mockUser);

      expect(result).toEqual(mockUser);
    });
  });

  describe('updateProfile', () => {
    it('should call service.updateProfile with userId and dto', async () => {
      const dto: UpdateUserDto = { displayName: 'Updated Name' };
      const updated = { ...mockUser, displayName: 'Updated Name' };
      service.updateProfile.mockResolvedValue(updated);

      const result = await controller.updateProfile('user-1', dto);

      expect(service.updateProfile).toHaveBeenCalledWith('user-1', dto);
      expect(result).toEqual(updated);
    });
  });

  describe('findAll', () => {
    it('should call service.findAll with page and limit and return paginated response', async () => {
      const pagination: PaginationDto = { page: 2, limit: 10 } as PaginationDto;
      const data = [mockUser];
      service.findAll.mockResolvedValue({ data, total: 1, page: 2, limit: 10 });

      const result = await controller.findAll(pagination);

      expect(service.findAll).toHaveBeenCalledWith(2, 10);
      expect(result).toMatchObject({
        success: true,
        data,
        meta: { total: 1, page: 2, limit: 10, totalPages: 1 },
      });
    });
  });

  describe('updateRole', () => {
    it('should call service.updateRole with actorUserId, id and dto', async () => {
      const dto: UpdateRoleDto = { role: UserRole.ADMIN };
      const updated = { ...mockUser, role: UserRole.ADMIN };
      service.updateRole.mockResolvedValue(updated);

      const result = await controller.updateRole('actor-1', 'user-1', dto);

      expect(service.updateRole).toHaveBeenCalledWith('actor-1', 'user-1', dto);
      expect(result).toEqual(updated);
    });
  });

  describe('deactivate', () => {
    it('should call service.softDelete with the actor and target user ids', async () => {
      service.softDelete.mockResolvedValue(undefined);

      const result = await controller.deactivate('actor-1', 'user-1');

      expect(service.softDelete).toHaveBeenCalledWith('actor-1', 'user-1');
      expect(result).toBeUndefined();
    });
  });
});
