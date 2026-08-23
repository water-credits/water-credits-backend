import { Controller, Get, Post, Body, Query, Param, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { OracleService, AggregatedReading } from './oracle.service';
import { OracleQueryDto } from './dto/oracle-query.dto';
import { TriggerSubmissionDto } from './dto/trigger-submission.dto';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from '../users/entities/user.entity';
import { OracleSubmission } from './entities/oracle-submission.entity';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';
import { ThrottleOracle, ThrottleAdmin } from '../../common/decorators/throttle.decorator';

@ApiTags('oracle')
@ApiBearerAuth()
@Controller('oracle')
export class OracleController {
  constructor(private readonly oracleService: OracleService) {}

  @Get('status')
  @ThrottleAdmin()
  @Roles(UserRole.ADMIN, UserRole.VERIFIER)
  @ApiOperation({ summary: 'Get oracle node health status' })
  async getStatus() {
    return this.oracleService.getStatus();
  }

  @Get('submissions')
  @Roles(UserRole.ADMIN, UserRole.VERIFIER, UserRole.ORACLE)
  @ApiOperation({ summary: 'List oracle submission history (paginated)' })
  async getSubmissions(
    @Query() query: OracleQueryDto,
  ): Promise<PaginatedResponseDto<OracleSubmission>> {
    const result = await this.oracleService.getSubmissions(query);
    return PaginatedResponseDto.fromList(result);
  }

  @Get('pending')
  @Roles(UserRole.ADMIN, UserRole.ORACLE)
  @ApiOperation({ summary: 'List pending oracle submissions' })
  async getPending(): Promise<OracleSubmission[]> {
    return this.oracleService.getPendingSubmissions();
  }

  @Post('trigger')
  @ThrottleOracle()
  @Roles(UserRole.ADMIN, UserRole.ORACLE)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Manually trigger an oracle submission cycle' })
  async triggerSubmission(@Body() dto: TriggerSubmissionDto): Promise<OracleSubmission> {
    return this.oracleService.triggerSubmission(dto);
  }

  @Get('aggregate/:projectId')
  @Public()
  @ApiOperation({ summary: 'Aggregate verified readings for a project' })
  async aggregateReadings(
    @Param('projectId') projectId: string,
    @Query('startTime') startTime?: string,
    @Query('endTime') endTime?: string,
  ): Promise<AggregatedReading> {
    return this.oracleService.aggregateReadings(
      projectId,
      startTime ? new Date(startTime) : undefined,
      endTime ? new Date(endTime) : undefined,
    );
  }
}
