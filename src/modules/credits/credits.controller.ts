import { Controller, Get, Post, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { CreditsService } from './credits.service';
import { RetireCreditsDto } from './dto/retire-credits.dto';
import { CreditQueryDto } from './dto/credit-query.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { Retirement } from './entities/retirement.entity';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';

@ApiTags('credits')
@ApiBearerAuth()
@Controller('credits')
export class CreditsController {
  constructor(private readonly creditsService: CreditsService) {}

  @Get()
  @ApiOperation({ summary: 'Get a global credit overview' })
  async getCreditOverview() {
    return this.creditsService.getCreditOverview();
  }

  @Get('projects/:projectId')
  @ApiOperation({ summary: 'Get credit details for a project' })
  async getProjectCredits(@Param('projectId') projectId: string) {
    return this.creditsService.getProjectCredits(projectId);
  }

  @Get('portfolio')
  @ApiOperation({ summary: 'Get the current user credit portfolio' })
  async getPortfolio(@CurrentUser('id') userId: string) {
    return this.creditsService.getPortfolio(userId);
  }

  @Post('retire')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Initiate a credit retirement' })
  async retire(
    @CurrentUser('id') userId: string,
    @Body() dto: RetireCreditsDto,
  ): Promise<Retirement> {
    return this.creditsService.retire(userId, dto);
  }

  @Get('retirements')
  @ApiOperation({ summary: 'List the current user retirement history (paginated)' })
  async getRetirements(
    @CurrentUser('id') userId: string,
    @Query() query: CreditQueryDto,
  ): Promise<PaginatedResponseDto<Retirement>> {
    const result = await this.creditsService.getRetirements(userId, query);
    return PaginatedResponseDto.fromList(result);
  }

  @Get('retirements/:id/certificate')
  @ApiOperation({ summary: 'Get a retirement certificate' })
  async getCertificate(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
  ): Promise<Retirement> {
    return this.creditsService.getCertificate(id, userId);
  }

  @Get('total-retired')
  @Public()
  @ApiOperation({ summary: 'Get the total number of retired credits' })
  async getTotalRetired(): Promise<{ total: number }> {
    const total = await this.creditsService.getTotalRetired();
    return { total };
  }
}
