import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { ProjectsService } from './projects.service';
import { CreateProjectDto } from './dto/create-project.dto';
import { UpdateProjectDto } from './dto/update-project.dto';
import { QueryProjectsDto } from './dto/query-projects.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from '../users/entities/user.entity';
import { Project, ProjectStatus } from './entities/project.entity';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';

@ApiTags('projects')
@ApiBearerAuth()
@Controller('projects')
export class ProjectsController {
  constructor(private readonly projectsService: ProjectsService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new project' })
  async create(@CurrentUser('id') userId: string, @Body() dto: CreateProjectDto): Promise<Project> {
    return this.projectsService.create(userId, dto);
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'List projects (filterable and paginated)' })
  async findAll(@Query() query: QueryProjectsDto): Promise<PaginatedResponseDto<Project>> {
    const { data, total, page, limit } = await this.projectsService.findAll(query);
    return PaginatedResponseDto.from(data, total, page, limit);
  }

  @Get(':id')
  @Public()
  @ApiOperation({ summary: 'Get a project by ID' })
  async findById(@Param('id') id: string): Promise<Project> {
    return this.projectsService.findById(id);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update project metadata' })
  async update(
    @Param('id') id: string,
    @Body() dto: UpdateProjectDto,
    @CurrentUser('id') userId: string,
  ): Promise<Project> {
    return this.projectsService.update(id, dto, userId);
  }

  @Patch(':id/status')
  @Roles(UserRole.ADMIN, UserRole.VERIFIER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update a project lifecycle status' })
  async updateStatus(@Param('id') id: string, @Body('status') status: string): Promise<Project> {
    return this.projectsService.updateStatus(id, status as ProjectStatus);
  }

  @Get('count/by-owner')
  @ApiOperation({ summary: 'Count projects owned by the current user' })
  async countByOwner(@CurrentUser('id') userId: string): Promise<{ count: number }> {
    const count = await this.projectsService.countByOwner(userId);
    return { count };
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete a project' })
  async remove(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') callerRole: UserRole,
  ): Promise<void> {
    return this.projectsService.remove(id, userId, callerRole);
  }
}
