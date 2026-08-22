import { Test, TestingModule } from '@nestjs/testing';
import { NotificationsService } from './notifications.service';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Notification } from './entities/notification.entity';
import { NotificationsGateway } from './notifications.gateway';

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

describe('NotificationsService', () => {
  let service: NotificationsService;
  let qb: ReturnType<typeof makeQb>;
  let repo: { createQueryBuilder: jest.Mock; [key: string]: jest.Mock };

  beforeEach(async () => {
    qb = makeQb();
    repo = {
      find: jest.fn(),
      findOne: jest.fn(),
      create: jest.fn(),
      save: jest.fn(),
      count: jest.fn(),
      createQueryBuilder: jest.fn(() => qb),
    };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        NotificationsService,
        {
          provide: getRepositoryToken(Notification),
          useValue: repo,
        },
        {
          provide: NotificationsGateway,
          useValue: {
            sendNotification: jest.fn(),
            server: { to: jest.fn(() => ({ emit: jest.fn() })) },
          },
        },
      ],
    }).compile();

    service = module.get<NotificationsService>(NotificationsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  describe('getNotifications', () => {
    it('scopes to the user and offset-paginates by default', async () => {
      const rows = [{ id: 'n1' }, { id: 'n2' }];
      qb.getManyAndCount.mockResolvedValue([rows, 2]);

      const result = await service.getNotifications('user-1');

      expect(qb.where).toHaveBeenCalledWith('notification.user_id = :userId', {
        userId: 'user-1',
      });
      expect(qb.orderBy).toHaveBeenCalledWith('notification.created_at', 'DESC');
      expect(qb.addOrderBy).toHaveBeenCalledWith('notification.id', 'DESC');
      expect(result).toEqual({ data: rows, total: 2, page: 1, limit: 20 });
    });

    it('uses keyset mode and emits a nextCursor when a cursor is supplied', async () => {
      const createdAt = new Date('2026-02-01T00:00:00Z');
      const rows = [
        { id: 'n1', createdAt },
        { id: 'n2', createdAt },
        { id: 'n3', createdAt },
      ];
      qb.getMany.mockResolvedValue(rows);

      const cursor = Buffer.from(
        JSON.stringify({ v: new Date('2026-03-01T00:00:00Z').toISOString(), id: 'seed' }),
      ).toString('base64url');

      const result = await service.getNotifications('user-1', { cursor, limit: 2 });

      expect(qb.take).toHaveBeenCalledWith(3); // limit + 1 over-fetch
      expect(qb.skip).not.toHaveBeenCalled();
      expect(result.data).toHaveLength(2);
      expect(result.hasMore).toBe(true);
      expect(result.nextCursor).toBeTruthy();
      expect(result.total).toBeUndefined();
    });
  });
});
