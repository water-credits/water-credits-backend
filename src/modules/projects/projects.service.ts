import {
  Injectable,
  Logger,
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
import { UserRole } from '../users/entities/user.entity';

const VALID_TRANSITIONS: Record<ProjectStatus, ProjectStatus[]> = {
  [ProjectStatus.DRAFT]: [ProjectStatus.REGISTERED],
  [ProjectStatus.REGISTERED]: [ProjectStatus.BASELINE],
  [ProjectStatus.BASELINE]: [ProjectStatus.ACTIVE],
  [ProjectStatus.ACTIVE]: [ProjectStatus.COMPLETED, ProjectStatus.CLOSED],
  [ProjectStatus.COMPLETED]: [ProjectStatus.CLOSED],
  [ProjectStatus.CLOSED]: [],
};

// Roles allowed to bypass the project ownership check on delete.
const ADMIN_ROLES: string[] = [UserRole.ADMIN, UserRole.SUPER_ADMIN];

@Injectable()
export class ProjectsService {
  private readonly logger = new Logger(ProjectsService.name);

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

    if (query.lat !== undefined && query.lng !== undefined && query.radius !== undefined) {
      const kmPerDegree = 111.32;
      const latDelta = query.radius / kmPerDegree;
      const lngDelta = query.radius / (kmPerDegree * Math.cos((query.lat * Math.PI) / 180));
      qb.andWhere('project.latitude BETWEEN :latMin AND :latMax', {
        latMin: query.lat - latDelta,
        latMax: query.lat + latDelta,
      });
      qb.andWhere('project.longitude BETWEEN :lngMin AND :lngMax', {
        lngMin: query.lng - lngDelta,
        lngMax: query.lng + lngDelta,
      });
    }

    this.applySorting(qb, query.sortBy, query.sortOrder);

    qb.skip(query.skip).take(query.limit);

    const [data, total] = await qb.getManyAndCount();
    return { data, total, page: query.page ?? 1, limit: query.limit ?? 20 };
  }

  private applySorting(
    qb: SelectQueryBuilder<Project>,
    sortBy?: string,
    sortOrder?: SortOrder,
  ): void {
    const allowedSortColumns = [
      'name',
      'status',
      'methodology',
      'area_hectares',
      'created_at',
      'updated_at',
      'latitude',
      'longitude',
    ];
    const column = sortBy && allowedSortColumns.includes(sortBy) ? sortBy : 'created_at';
    const order = sortOrder === SortOrder.ASC ? 'ASC' : 'DESC';
    qb.orderBy(`project.${column}`, order);
  }

  async countByOwner(ownerId: string): Promise<number> {
    return this.projectRepo.count({ where: { ownerId } });
  }

  async count(): Promise<number> {
    return this.projectRepo.count();
  }

  async remove(id: string, userId: string, callerRole?: UserRole): Promise<void> {
    const project = await this.findById(id);

    const isAdmin = callerRole !== undefined && ADMIN_ROLES.includes(callerRole);

    if (!isAdmin && project.ownerId !== userId) {
      throw new ForbiddenException('You can only delete your own projects');
    }

    if (isAdmin && project.ownerId !== userId) {
      this.logger.warn(
        `Admin override: user ${userId} (role=${callerRole}) deleted project ${id} owned by ${project.ownerId}`,
      );
    }

    await this.projectRepo.remove(project);
  }
}
