import { Test, TestingModule } from '@nestjs/testing';
import { ProjectsController } from './projects.controller';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';
import { Project, ProjectStatus } from './entities/project.entity';
import { UserRole } from '../users/entities/user.entity';
describe('ProjectsController', () => {
  let controller: ProjectsController;
  let service: jest.Mocked<ProjectsService>;

  const mockProject: Project = {
    id: 'proj-1',
    ownerId: 'user-1',
    owner: null as never,
    name: 'Test Project',
    description: 'A test project',
    latitude: 10.5,
    longitude: 20.5,
    methodology: 'VM001',
    status: ProjectStatus.DRAFT,
    areaHectares: 100,
    creditTokenAddress: null,
    contractId: null,
    baselineStartDate: null,
    baselineEndDate: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  beforeEach(async () => {
    const module: TestingModule = await Test.createTestingModule({
      controllers: [ProjectsController],
      providers: [
        {
          provide: ProjectsService,
          useValue: {
            create: jest.fn(),
            findAll: jest.fn(),
            findById: jest.fn(),
            update: jest.fn(),
            updateStatus: jest.fn(),
            countByOwner: jest.fn(),
            remove: jest.fn(),
          },
        },
      ],
    }).compile();

    controller = module.get<ProjectsController>(ProjectsController);
    service = module.get(ProjectsService);
  });

  it('should be defined', () => {
    expect(controller).toBeDefined();
  });

  describe('create', () => {
    it('should call service.create with userId and dto', async () => {
      const dto: CreateProjectDto = {
        name: 'New Project',
        latitude: 10,
        longitude: 20,
        methodology: 'VM001',
        areaHectares: 50,
      };
      service.create.mockResolvedValue(mockProject);

      const result = await controller.create('user-1', dto);

      expect(service.create).toHaveBeenCalledWith('user-1', dto);
      expect(result).toEqual(mockProject);
    });
  });

  describe('findAll', () => {
    it('should call service.findAll with query and return PaginatedResponseDto', async () => {
      const query: QueryProjectsDto = { page: 1, limit: 20 } as QueryProjectsDto;
      const data = [mockProject];
      service.findAll.mockResolvedValue({ data, total: 1, page: 1, limit: 20 });

      const result = await controller.findAll(query);

      expect(service.findAll).toHaveBeenCalledWith(query);
      expect(result).toMatchObject({
        success: true,
        data,
        meta: { total: 1, page: 1, limit: 20, totalPages: 1 },
      });
    });
  });

  describe('findById', () => {
    it('should call service.findById with the id param', async () => {
      service.findById.mockResolvedValue(mockProject);

      const result = await controller.findById('proj-1');

      expect(service.findById).toHaveBeenCalledWith('proj-1');
      expect(result).toEqual(mockProject);
    });
  });

  describe('update', () => {
    it('should call service.update with id, dto, and userId', async () => {
      const dto: UpdateProjectDto = { name: 'Updated Name' };
      service.update.mockResolvedValue({ ...mockProject, name: 'Updated Name' });

      const result = await controller.update('proj-1', dto, 'user-1');

      expect(service.update).toHaveBeenCalledWith('proj-1', dto, 'user-1');
      expect(result).toEqual({ ...mockProject, name: 'Updated Name' });
    });
  });

  describe('updateStatus', () => {
    it('should call service.updateStatus with id and status', async () => {
      const status = ProjectStatus.ACTIVE;
      service.updateStatus.mockResolvedValue({ ...mockProject, status });

      const result = await controller.updateStatus('proj-1', status as never);

      expect(service.updateStatus).toHaveBeenCalledWith('proj-1', status);
      expect(result).toEqual({ ...mockProject, status });
    });
  });

  describe('countByOwner', () => {
    it('should call service.countByOwner with userId and return { count }', async () => {
      service.countByOwner.mockResolvedValue(5);

      const result = await controller.countByOwner('user-1');

      expect(service.countByOwner).toHaveBeenCalledWith('user-1');
      expect(result).toEqual({ count: 5 });
    });
  });

  describe('remove', () => {
    it('should call service.remove with id, userId and callerRole', async () => {
      service.remove.mockResolvedValue(undefined);

      const result = await controller.remove('proj-1', 'user-1', UserRole.FARMER);

      expect(service.remove).toHaveBeenCalledWith('proj-1', 'user-1', UserRole.FARMER);
      expect(result).toBeUndefined();
    });
  });
});
