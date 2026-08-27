import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectsService } from './projects.service';
import { Project, ProjectStatus } from './entities/project.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto, SortOrder } from './dto/query-projects.dto';
import { UserRole } from '../users/entities/user.entity';
import * as keysetPaginator from '../../common/pagination/keyset-paginator';
import { PaginatedList } from '../../common/pagination/keyset-paginator';

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeProject(overrides: Partial<Project> = {}): Project {
  return {
    id: 'proj-uuid-1',
    ownerId: 'user-uuid-1',
    name: 'Test Project',
    description: 'A test project',
    latitude: 10.5,
    longitude: 20.5,
    methodology: 'VM001',
    areaHectares: 100,
    status: ProjectStatus.DRAFT,
    baselineStartDate: null,
    baselineEndDate: null,
    creditTokenAddress: null,
    contractId: null,
    owner: null as never,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    ...overrides,
  } as Project;
}

type MockRepo = {
  findOne: jest.Mock;
  find: jest.Mock;
  create: jest.Mock;
  save: jest.Mock;
  createQueryBuilder: jest.Mock;
  count: jest.Mock;
  remove: jest.Mock;
};

function makeMockRepo(): MockRepo {
  return {
    findOne: jest.fn(),
    find: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    createQueryBuilder: jest.fn(),
    count: jest.fn(),
    remove: jest.fn(),
  };
}

function makeQueryBuilder(overrides: Partial<Record<string, jest.Mock>> = {}) {
  return {
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    addOrderBy: jest.fn().mockReturnThis(),
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getManyAndCount: jest.fn().mockResolvedValue([[], 0]),
    ...overrides,
  };
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe('ProjectsService', () => {
  let service: ProjectsService;
  let projectRepo: MockRepo;

  beforeEach(async () => {
    projectRepo = makeMockRepo();

    const module: TestingModule = await Test.createTestingModule({
      providers: [ProjectsService, { provide: getRepositoryToken(Project), useValue: projectRepo }],
    }).compile();

    service = module.get<ProjectsService>(ProjectsService);
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  // ── create ───────────────────────────────────────────────────────────────

  describe('create', () => {
    it('creates and returns a project with DRAFT status', async () => {
      const dto: CreateProjectDto = {
        name: 'New Project',
        description: 'A brand new project',
        latitude: 15.0,
        longitude: 30.0,
        methodology: 'VM002',
        areaHectares: 200,
        baselineStartDate: '2026-06-01T00:00:00Z',
        baselineEndDate: '2026-12-31T00:00:00Z',
      };

      const created = makeProject({
        name: dto.name,
        description: dto.description,
        latitude: dto.latitude,
        longitude: dto.longitude,
        methodology: dto.methodology,
        areaHectares: dto.areaHectares,
        baselineStartDate: new Date(dto.baselineStartDate!),
        baselineEndDate: new Date(dto.baselineEndDate!),
      });

      projectRepo.create.mockReturnValue(created);
      projectRepo.save.mockResolvedValue(created);

      const result = await service.create('user-uuid-1', dto);

      expect(projectRepo.create).toHaveBeenCalledWith({
        ownerId: 'user-uuid-1',
        name: dto.name,
        description: dto.description,
        latitude: dto.latitude,
        longitude: dto.longitude,
        methodology: dto.methodology,
        areaHectares: dto.areaHectares,
        baselineStartDate: new Date(dto.baselineStartDate!),
        baselineEndDate: new Date(dto.baselineEndDate!),
        status: ProjectStatus.DRAFT,
      });
      expect(projectRepo.save).toHaveBeenCalledWith(created);
      expect(result).toEqual(created);
    });

    it('sets null for optional fields when not provided', async () => {
      const dto: CreateProjectDto = {
        name: 'Minimal Project',
        latitude: 0,
        longitude: 0,
        methodology: 'VM003',
        areaHectares: 50,
      };

      const created = makeProject({ name: dto.name });
      projectRepo.create.mockReturnValue(created);
      projectRepo.save.mockResolvedValue(created);

      const result = await service.create('user-uuid-2', dto);

      expect(projectRepo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          description: null,
          baselineStartDate: null,
          baselineEndDate: null,
        }),
      );
      expect(result).toEqual(created);
    });
  });

  // ── findById ─────────────────────────────────────────────────────────────

  describe('findById', () => {
    it('returns the project when found', async () => {
      const project = makeProject();
      projectRepo.findOne.mockResolvedValue(project);

      const result = await service.findById('proj-uuid-1');

      expect(projectRepo.findOne).toHaveBeenCalledWith({ where: { id: 'proj-uuid-1' } });
      expect(result).toEqual(project);
    });

    it('throws NotFoundException when not found', async () => {
      projectRepo.findOne.mockResolvedValue(null);

      await expect(service.findById('nonexistent')).rejects.toThrow(NotFoundException);
      await expect(service.findById('nonexistent')).rejects.toThrow('Project not found');
    });
  });

  // ── update ───────────────────────────────────────────────────────────────

  describe('update', () => {
    it('updates all writable fields', async () => {
      const project = makeProject();
      projectRepo.findOne.mockResolvedValue(project);

      const dto: UpdateProjectDto = {
        name: 'Updated Name',
        description: 'Updated description',
        latitude: 20.0,
        longitude: 40.0,
        methodology: 'VM010',
        areaHectares: 500,
        baselineStartDate: '2027-01-01T00:00:00Z',
        baselineEndDate: '2027-12-31T00:00:00Z',
      };

      projectRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.update('proj-uuid-1', dto, 'user-uuid-1');

      expect(result.name).toBe('Updated Name');
      expect(result.description).toBe('Updated description');
      expect(result.latitude).toBe(20.0);
      expect(result.longitude).toBe(40.0);
      expect(result.methodology).toBe('VM010');
      expect(result.areaHectares).toBe(500);
      expect(result.baselineStartDate).toEqual(new Date('2027-01-01T00:00:00Z'));
      expect(result.baselineEndDate).toEqual(new Date('2027-12-31T00:00:00Z'));
      expect(projectRepo.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'proj-uuid-1' }));
    });

    it('partial update: only updates provided fields', async () => {
      const project = makeProject({ name: 'Original', description: 'Original desc' });
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.update('proj-uuid-1', { name: 'Only Name' }, 'user-uuid-1');

      expect(result.name).toBe('Only Name');
      expect(result.description).toBe('Original desc');
      expect(projectRepo.save).toHaveBeenCalled();
    });

    it('throws ForbiddenException when userId does not match', async () => {
      const project = makeProject({ ownerId: 'other-user' });
      projectRepo.findOne.mockResolvedValue(project);

      await expect(
        service.update('proj-uuid-1', { name: 'Hacked' }, 'different-user'),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.update('proj-uuid-1', { name: 'Hacked' }, 'different-user'),
      ).rejects.toThrow('You can only update your own projects');
    });

    it('skips owner check when userId is undefined', async () => {
      const project = makeProject();
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.update('proj-uuid-1', { name: 'Updated' });

      expect(result.name).toBe('Updated');
      expect(projectRepo.save).toHaveBeenCalled();
    });

    it('allows valid status transition DRAFT -> REGISTERED', async () => {
      const project = makeProject({ status: ProjectStatus.DRAFT });
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.update(
        'proj-uuid-1',
        { status: ProjectStatus.REGISTERED },
        'user-uuid-1',
      );

      expect(result.status).toBe(ProjectStatus.REGISTERED);
      expect(projectRepo.save).toHaveBeenCalled();
    });

    it('throws BadRequestException for invalid status transition DRAFT -> ACTIVE', async () => {
      const project = makeProject({ status: ProjectStatus.DRAFT });
      projectRepo.findOne.mockResolvedValue(project);

      await expect(
        service.update('proj-uuid-1', { status: ProjectStatus.ACTIVE }, 'user-uuid-1'),
      ).rejects.toThrow(BadRequestException);
      await expect(
        service.update('proj-uuid-1', { status: ProjectStatus.ACTIVE }, 'user-uuid-1'),
      ).rejects.toThrow('Cannot transition from draft to active');
    });

    it('allows same status (no transition validation error)', async () => {
      const project = makeProject({ status: ProjectStatus.REGISTERED });
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.update(
        'proj-uuid-1',
        { status: ProjectStatus.REGISTERED },
        'user-uuid-1',
      );

      expect(result.status).toBe(ProjectStatus.REGISTERED);
      expect(projectRepo.save).toHaveBeenCalled();
    });

    it('throws NotFoundException when project does not exist', async () => {
      projectRepo.findOne.mockResolvedValue(null);

      await expect(service.update('nonexistent', { name: 'Nope' }, 'user-uuid-1')).rejects.toThrow(
        NotFoundException,
      );
    });
  });

  // ── updateStatus ─────────────────────────────────────────────────────────

  describe('updateStatus', () => {
    it('delegates to update with the given status and userId', async () => {
      const project = makeProject({ status: ProjectStatus.DRAFT });
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.save.mockImplementation((p) => Promise.resolve(p));

      const result = await service.updateStatus(
        'proj-uuid-1',
        ProjectStatus.REGISTERED,
        'user-uuid-1',
      );

      expect(result.status).toBe(ProjectStatus.REGISTERED);
      expect(projectRepo.save).toHaveBeenCalled();
    });
  });

  // ── findAll ──────────────────────────────────────────────────────────────

  describe('findAll', () => {
    const projects = [
      makeProject({
        id: 'proj-1',
        name: 'Alpha',
        methodology: 'VM001',
        status: ProjectStatus.ACTIVE,
        createdAt: new Date('2026-06-01T00:00:00Z'),
      }),
      makeProject({
        id: 'proj-2',
        name: 'Beta',
        methodology: 'VM002',
        status: ProjectStatus.DRAFT,
        createdAt: new Date('2026-05-01T00:00:00Z'),
      }),
    ];

    // Helper: build an offset-mode PaginatedList
    function offsetList(
      data: Project[],
      total: number,
      page = 1,
      limit = 20,
    ): PaginatedList<Project> {
      return { data, total, page, limit };
    }

    // Helper: build a cursor-mode PaginatedList
    function cursorList(
      data: Project[],
      nextCursor: string | null = null,
      hasMore = false,
      limit = 20,
    ): PaginatedList<Project> {
      return { data, limit, nextCursor, hasMore };
    }

    let paginateSpy: jest.SpyInstance;

    beforeEach(() => {
      // Spy on the real paginate() so we can control its output without needing
      // a live DB. Individual tests override the resolved value as needed.
      paginateSpy = jest
        .spyOn(keysetPaginator, 'paginate')
        .mockResolvedValue(offsetList([], 0));
    });

    afterEach(() => {
      paginateSpy.mockRestore();
    });

    // ── offset mode ────────────────────────────────────────────────────────

    it('returns a PaginatedList in offset mode (page + limit, no cursor)', async () => {
      paginateSpy.mockResolvedValue(offsetList(projects, 2, 1, 20));
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      const query = { page: 1, limit: 20 } as QueryProjectsDto;
      const result = await service.findAll(query);

      expect(result.data).toEqual(projects);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      // Cursor fields must be absent in offset mode
      expect(result.nextCursor).toBeUndefined();
      expect(result.hasMore).toBeUndefined();
    });

    it('passes page, limit, and no cursor to paginate() in offset mode', async () => {
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      const query = { page: 2, limit: 10 } as QueryProjectsDto;
      await service.findAll(query);

      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ alias: 'project' }),
        { cursor: undefined, page: 2, limit: 10 },
      );
    });

    it('uses defaults when page and limit are not provided', async () => {
      paginateSpy.mockResolvedValue(offsetList([], 0, 1, 20));
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      await service.findAll({} as QueryProjectsDto);

      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ page: undefined, limit: undefined }),
      );
    });

    // ── cursor mode ────────────────────────────────────────────────────────

    it('returns a PaginatedList in cursor mode when cursor is supplied', async () => {
      const nextCursor = 'eyJ2IjoiMjAyNi0wNi0wMVQwMDowMDowMC4wMDBaIiwiaWQiOiJwcm9qLTEifQ';
      paginateSpy.mockResolvedValue(cursorList([projects[0]], nextCursor, true, 1));
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      const query = { cursor: 'some-opaque-cursor', limit: 1 } as QueryProjectsDto;
      const result = await service.findAll(query);

      expect(result.data).toEqual([projects[0]]);
      expect(result.nextCursor).toBe(nextCursor);
      expect(result.hasMore).toBe(true);
      // Offset fields must be absent in cursor mode
      expect(result.total).toBeUndefined();
      expect(result.page).toBeUndefined();
    });

    it('passes cursor to paginate() in cursor mode', async () => {
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      const opaqueCursor = 'eyJ2IjoiMjAyNi0wNi0wMVQwMDowMDowMC4wMDBaIiwiaWQiOiJwcm9qLTEifQ';
      const query = { cursor: opaqueCursor, limit: 5 } as QueryProjectsDto;
      await service.findAll(query);

      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ alias: 'project' }),
        { cursor: opaqueCursor, page: undefined, limit: 5 },
      );
    });

    it('returns hasMore=false and nextCursor=null on the last cursor page', async () => {
      paginateSpy.mockResolvedValue(cursorList([projects[1]], null, false, 20));
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      const result = await service.findAll({ cursor: 'any-cursor' } as QueryProjectsDto);

      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    // ── sort resolution ────────────────────────────────────────────────────

    it('passes sortColumn=project.created_at and direction=DESC by default', async () => {
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      await service.findAll({} as QueryProjectsDto);

      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sortColumn: 'project.created_at',
          sortProperty: 'createdAt',
          direction: 'DESC',
        }),
        expect.anything(),
      );
    });

    it('resolves sortBy=name to sortColumn=project.name and sortProperty=name', async () => {
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      await service.findAll({ sortBy: 'name', sortOrder: SortOrder.ASC } as QueryProjectsDto);

      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sortColumn: 'project.name',
          sortProperty: 'name',
          direction: 'ASC',
        }),
        expect.anything(),
      );
    });

    it('resolves sortBy=area_hectares to sortProperty=areaHectares', async () => {
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      await service.findAll({ sortBy: 'area_hectares' } as QueryProjectsDto);

      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          sortColumn: 'project.area_hectares',
          sortProperty: 'areaHectares',
        }),
        expect.anything(),
      );
    });

    it('falls back to created_at when sortBy is an unknown column', async () => {
      projectRepo.createQueryBuilder.mockReturnValue(makeQueryBuilder());

      await service.findAll({ sortBy: 'invalid_column' } as QueryProjectsDto);

      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ sortColumn: 'project.created_at', sortProperty: 'createdAt' }),
        expect.anything(),
      );
    });

    // ── filters ────────────────────────────────────────────────────────────

    it('applies status filter', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ status: ProjectStatus.ACTIVE } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledWith('project.status = :status', {
        status: ProjectStatus.ACTIVE,
      });
    });

    it('applies methodology filter', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ methodology: 'VM001' } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledWith('project.methodology = :methodology', {
        methodology: 'VM001',
      });
    });

    it('applies ownerId filter', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ ownerId: 'user-uuid-1' } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledWith('project.owner_id = :ownerId', {
        ownerId: 'user-uuid-1',
      });
    });

    it('applies text search filter (Brackets with ILIKE)', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ search: 'wetland' } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      // The argument is a Brackets instance, not a plain string
      const [arg] = qb.andWhere.mock.calls[0];
      expect(arg).toHaveProperty('whereFactory');
    });

    it('applies geo bounding-box filter when lat, lng, and radius are all provided', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ lat: 10, lng: 20, radius: 50 } as QueryProjectsDto);

      const kmPerDegree = 111.32;
      const latDelta = 50 / kmPerDegree;
      const lngDelta = 50 / (kmPerDegree * Math.cos((10 * Math.PI) / 180));

      expect(qb.andWhere).toHaveBeenCalledWith('project.latitude BETWEEN :latMin AND :latMax', {
        latMin: 10 - latDelta,
        latMax: 10 + latDelta,
      });
      expect(qb.andWhere).toHaveBeenCalledWith('project.longitude BETWEEN :lngMin AND :lngMax', {
        lngMin: 20 - lngDelta,
        lngMax: 20 + lngDelta,
      });
    });

    it('does not apply geo filter when only some coordinates are provided', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({ lat: 10 } as QueryProjectsDto);

      const geoCall = qb.andWhere.mock.calls.find(
        ([clause]: [unknown]) => typeof clause === 'string' && clause.includes('BETWEEN'),
      );
      expect(geoCall).toBeUndefined();
    });

    it('combines status filter with cursor pagination', async () => {
      const nextCursor = 'some-cursor';
      paginateSpy.mockResolvedValue(cursorList([projects[0]], nextCursor, true));
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({
        status: ProjectStatus.ACTIVE,
        cursor: 'prev-cursor',
        limit: 10,
      } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledWith('project.status = :status', {
        status: ProjectStatus.ACTIVE,
      });
      expect(paginateSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.objectContaining({ cursor: 'prev-cursor', limit: 10 }),
      );
      expect(result.nextCursor).toBe(nextCursor);
    });
  });

  // ── countByOwner ─────────────────────────────────────────────────────────

  describe('countByOwner', () => {
    it('returns the count for a given owner', async () => {
      projectRepo.count.mockResolvedValue(5);

      const result = await service.countByOwner('user-uuid-1');

      expect(projectRepo.count).toHaveBeenCalledWith({
        where: { ownerId: 'user-uuid-1' },
      });
      expect(result).toBe(5);
    });
  });

  // ── count ────────────────────────────────────────────────────────────────

  describe('count', () => {
    it('returns total count of projects', async () => {
      projectRepo.count.mockResolvedValue(10);

      const result = await service.count();

      expect(projectRepo.count).toHaveBeenCalledWith();
      expect(result).toBe(10);
    });
  });

  // ── remove ───────────────────────────────────────────────────────────────

  describe('remove', () => {
    it('deletes the project when user is the owner', async () => {
      const project = makeProject();
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.remove.mockResolvedValue(undefined);

      await service.remove('proj-uuid-1', 'user-uuid-1', UserRole.FARMER);

      expect(projectRepo.findOne).toHaveBeenCalledWith({ where: { id: 'proj-uuid-1' } });
      expect(projectRepo.remove).toHaveBeenCalledWith(project);
    });

    it('throws ForbiddenException when a non-admin caller is not the owner', async () => {
      const project = makeProject({ ownerId: 'other-user' });
      projectRepo.findOne.mockResolvedValue(project);

      await expect(
        service.remove('proj-uuid-1', 'different-user', UserRole.FARMER),
      ).rejects.toThrow(ForbiddenException);
      await expect(
        service.remove('proj-uuid-1', 'different-user', UserRole.FARMER),
      ).rejects.toThrow('You can only delete your own projects');
      expect(projectRepo.remove).not.toHaveBeenCalled();
    });

    it('allows an admin to delete a project they do not own (ownership bypass)', async () => {
      const project = makeProject({ ownerId: 'other-user' });
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.remove.mockResolvedValue(undefined);

      await service.remove('proj-uuid-1', 'admin-user', UserRole.ADMIN);

      expect(projectRepo.remove).toHaveBeenCalledWith(project);
    });

    it('allows a super admin to delete a project they do not own', async () => {
      const project = makeProject({ ownerId: 'other-user' });
      projectRepo.findOne.mockResolvedValue(project);
      projectRepo.remove.mockResolvedValue(undefined);

      await service.remove('proj-uuid-1', 'super-admin-user', UserRole.SUPER_ADMIN);

      expect(projectRepo.remove).toHaveBeenCalledWith(project);
    });

    it('still enforces ownership for an admin who is not privileged via role param absence', async () => {
      const project = makeProject({ ownerId: 'other-user' });
      projectRepo.findOne.mockResolvedValue(project);

      await expect(service.remove('proj-uuid-1', 'some-user')).rejects.toThrow(ForbiddenException);
      expect(projectRepo.remove).not.toHaveBeenCalled();
    });

    it('throws NotFoundException when project does not exist', async () => {
      projectRepo.findOne.mockResolvedValue(null);

      await expect(service.remove('nonexistent', 'user-uuid-1')).rejects.toThrow(NotFoundException);
      expect(projectRepo.remove).not.toHaveBeenCalled();
    });
  });
});
