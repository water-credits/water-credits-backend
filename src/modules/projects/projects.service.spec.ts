import { Test, TestingModule } from '@nestjs/testing';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ProjectsService } from './projects.service';
import { Project, ProjectStatus } from './entities/project.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto, SortOrder } from './dto/query-projects.dto';
import { UserRole } from '../users/entities/user.entity';

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
    skip: jest.fn().mockReturnThis(),
    take: jest.fn().mockReturnThis(),
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
      }),
      makeProject({
        id: 'proj-2',
        name: 'Beta',
        methodology: 'VM002',
        status: ProjectStatus.DRAFT,
      }),
    ];

    it('returns paginated results with default sort (created_at DESC)', async () => {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn().mockResolvedValue([projects, 2]),
      });
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      const query = { page: 1, limit: 20, skip: 0 } as QueryProjectsDto;
      const result = await service.findAll(query);

      expect(result.data).toEqual(projects);
      expect(result.total).toBe(2);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(qb.orderBy).toHaveBeenCalledWith('project.created_at', 'DESC');
    });

    it('filters by status', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        status: ProjectStatus.ACTIVE,
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledWith('project.status = :status', {
        status: ProjectStatus.ACTIVE,
      });
    });

    it('filters by methodology', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        methodology: 'VM001',
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledWith('project.methodology = :methodology', {
        methodology: 'VM001',
      });
    });

    it('filters by ownerId', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        ownerId: 'user-uuid-1',
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledWith('project.owner_id = :ownerId', {
        ownerId: 'user-uuid-1',
      });
    });

    it('filters by search term (name and description via ILIKE)', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        search: 'test',
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

      expect(qb.andWhere).toHaveBeenCalledTimes(1);
      const arg = qb.andWhere.mock.calls[0][0];
      expect(arg).toHaveProperty('whereFactory');
    });

    it('filters by geo bounding box', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        lat: 10,
        lng: 20,
        radius: 50,
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

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

    it('applies custom sortBy and sortOrder', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        sortBy: 'name',
        sortOrder: SortOrder.ASC,
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

      expect(qb.orderBy).toHaveBeenCalledWith('project.name', 'ASC');
    });

    it('falls back to default sort when sortBy is invalid', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        sortBy: 'invalid_column',
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

      expect(qb.orderBy).toHaveBeenCalledWith('project.created_at', 'DESC');
    });

    it('uses defaults for page and limit when not provided', async () => {
      const qb = makeQueryBuilder({
        getManyAndCount: jest.fn().mockResolvedValue([projects, 2]),
      });
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      const result = await service.findAll({} as QueryProjectsDto);

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('ignores geo filter when only some coordinates are provided', async () => {
      const qb = makeQueryBuilder();
      projectRepo.createQueryBuilder.mockReturnValue(qb);

      await service.findAll({
        lat: 10,
        page: 1,
        limit: 20,
        skip: 0,
      } as QueryProjectsDto);

      // andWhere should NOT have been called with geo bounding-box clauses
      const geoCall = qb.andWhere.mock.calls.find(
        ([clause]: string[]) => typeof clause === 'string' && clause.includes('BETWEEN'),
      );
      expect(geoCall).toBeUndefined();
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
