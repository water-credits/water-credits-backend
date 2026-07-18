import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository, Brackets, SelectQueryBuilder } from 'typeorm';
import { Project, ProjectStatus } from './entities/project.entity';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto, SortOrder } from './dto/query-projects.dto';

const VALID_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.REGISTERED],
  [ProjectStatus.REGISTERED]: [ProjectStatus.BASELINE],
  [ProjectStatus.BASELINE]: [ProjectStatus.ACTIVE],
  // ACTIVE -> CLOSED is intentional: it covers early termination or
  // cancellation of a project without passing through COMPLETED (e.g. the
  // developer withdraws, or the site is decommissioned). ACTIVE -> COMPLETED
  // -> CLOSED remains the normal full-lifecycle path. Resolves the ambiguity
  // in issue #16.
  [ProjectStatus.ACTIVE]: [ProjectStatus.COMPLETED, ProjectStatus.CLOSED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.CLOSED],
  [ProjectStatus.CLOSED]: [],
};

@Injectable()
export class ProjectsService {
  constructor(
    @InjectRepository(Project)
    private readonly projectRepo: Repository<Project>,
  ) {}

  async create(ownerId: string, dto: CreateProjectDto): Promise<Project> {
    const project = this.projectRepo.create({
      ownerId,
      name: dto.name,
      description: dto.description ?? null,
      latitude: dto.latitude,
      longitude: dto.longitude,
      methodology: dto.methodology,
      areaHectares: dto.areaHectares,
      baselineStartDate: dto.baselineStartDate ? new Date(dto.baselineStartDate) : null,
      baselineEndDate: dto.baselineEndDate ? new Date(dto.baselineEndDate) : null,
      status: ProjectStatus.DRAFT,
    });
    return this.projectRepo.save(project);
  }

  async findById(id: string): Promise<Project> {
    const project = await this.projectRepo.findOne({ where: { id } });
    if (!project) {
      throw new NotFoundException('Project not found');
    }
    return project;
  }

  async update(id: string, dto: UpdateProjectDto, userId?: string): Promise<Project> {
    const project = await this.findById(id);

    if (userId && project.ownerId !== userId) {
      throw new ForbiddenException('You can only update your own projects');
    }

    if (dto.status !== undefined && dto.status !== project.status) {
      const allowed = VALID_TRANSITIONS[project.status];
      if (!allowed.includes(dto.status)) {
        throw new BadRequestException(`Cannot transition from ${project.status} to ${dto.status}`);
      }
    }

    if (dto.name !== undefined) {
      project.name = dto.name;
    }
    if (dto.description !== undefined) {
      project.description = dto.description;
    }
    if (dto.latitude !== undefined) {
      project.latitude = dto.latitude;
    }
    if (dto.longitude !== undefined) {
      project.longitude = dto.longitude;
    }
    if (dto.methodology !== undefined) {
      project.methodology = dto.methodology;
    }
    if (dto.areaHectares !== undefined) {
      project.areaHectares = dto.areaHectares;
    }
    if (dto.baselineStartDate !== undefined) {
      project.baselineStartDate = new Date(dto.baselineStartDate);
    }
    if (dto.baselineEndDate !== undefined) {
      project.baselineEndDate = new Date(dto.baselineEndDate);
    }
    if (dto.status !== undefined) {
      project.status = dto.status;
    }

    return this.projectRepo.save(project);
  }

  async updateStatus(id: string, status: ProjectStatus, userId?: string): Promise<Project> {
    return this.update(id, { status }, userId);
  }

  async findAll(
    query: QueryProjectsDto,
  ): Promise<{ data: Project[]; total: number; page: number; limit: number }> {
    const qb = this.projectRepo.createQueryBuilder('project');

    if (query.status) {
      qb.andWhere('project.status = :status', { status: query.status });
    }

    if (query.methodology) {
      qb.andWhere('project.methodology = :methodology', { methodology: query.methodology });
    }

    if (query.ownerId) {
      qb.andWhere('project.owner_id = :ownerId', { ownerId: query.ownerId });
    }

    if (query.search) {
      const search = `%${query.search}%`;
      qb.andWhere(
        new Brackets((qb) => {
          qb.where('project.name ILIKE :search', { search }).orWhere(
            'project.description ILIKE :search',
            { search },
          );
        }),
      );
    }

   if (filter.lat !== undefined && filter.lon !== undefined && filter.radius !== undefined) {
  const { lat, lon, radius } = filter; // radius in km
  const radiusMeters = radius * 1000;

  qb.addSelect(
    `earth_distance(ll_to_earth(:lat, :lon), ll_to_earth(project.latitude, project.longitude))`,
    'distance_m',
  )
    .andWhere(
      `earth_box(ll_to_earth(:lat, :lon), :radiusMeters) @> ll_to_earth(project.latitude, project.longitude)`,
    )
    .andWhere(
      `earth_distance(ll_to_earth(:lat, :lon), ll_to_earth(project.latitude, project.longitude)) <= :radiusMeters`,
    )
    .setParameters({ lat, lon, radiusMeters });
}

    this.applySorting(qb, query.sortBy, query.sortOrder);

    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: query.page ?? 1, limit: query.limit ?? 20 };
  }

  private static readonly SORT_FIELD_MAP: Record<string, string> = {
    name: 'project.name',
    status: 'project.status',
    methodology: 'project.methodology',
    areaHectares: 'project.areaHectares',
    createdAt: 'project.createdAt',
    updatedAt: 'project.updatedAt',
    latitude: 'project.latitude',
    longitude: 'project.longitude',
  };

  private applySorting(
    qb: SelectQueryBuilder<Project>,
    sortBy?: string,
    sortOrder?: SortOrder,
  ): void {
    const column = (sortBy && ProjectsService.SORT_FIELD_MAP[sortBy]) || 'project.createdAt';
    const order = sortOrder === SortOrder.ASC ? 'ASC' : 'DESC';
    qb.orderBy(column, order);
  }

  async countByOwner(ownerId: string): Promise<number> {
    return this.projectRepo.count({ where: { ownerId } });
  }

  async count(): Promise<number> {
    return this.projectRepo.count();
  }

  async remove(id: string, userId: string): Promise<void> {
    const project = await this.findById(id);

    if (project.ownerId !== userId) {
      throw new ForbiddenException('You can only delete your own projects');
    }

    await this.projectRepo.remove(project);
  }
}
