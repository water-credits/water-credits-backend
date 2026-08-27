import {
  Controller,
  Get,
  Post,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  Patch,
  ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { GovernanceService } from './governance.service';
import { CreateProposalDto } from './dto/create-proposal.dto';
import { VoteDto } from './dto/vote.dto';
import { GovernanceQueryDto } from './dto/governance-query.dto';
import { UpdateGovernanceConfigDto } from './dto/update-governance-config.dto';
import { PendingConfigChangeDto } from './dto/pending-config-change.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { Public } from '../../common/decorators/public.decorator';
import { UserRole } from '../users/entities/user.entity';
import { Proposal } from './entities/proposal.entity';
import { GovernanceConfig } from './entities/governance-config.entity';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';

@ApiTags('governance')
@ApiBearerAuth()
@Controller('governance')
export class GovernanceController {
  constructor(private readonly governanceService: GovernanceService) {}

  // ── Config (read) ─────────────────────────────────────────────────────────

  /**
   * GET /governance/config
   * Returns the current live protocol parameters.
   * Public — anyone can read the config.
   */
  @Get('config')
  @Public()
  @ApiOperation({ summary: 'Get current protocol parameters' })
  async getConfig(): Promise<GovernanceConfig> {
    return this.governanceService.getConfig();
  }

  // ── Config (timelocked write) ─────────────────────────────────────────────

  /**
   * PATCH /governance/config
   * Creates a pending config-change record.  Admins propose; the scheduler
   * applies after the timelock expires.
   *
   * Optional query param: ?force=true (SUPER_ADMIN only) — applies immediately
   * without a timelock and logs a config_emergency_updated event.
   */
  @Patch('config')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.ACCEPTED) // 202: change accepted, not yet applied
  @ApiOperation({ summary: 'Update protocol parameters (timelocked, admin)' })
  async updateConfig(
    @Body() dto: UpdateGovernanceConfigDto,
    @CurrentUser('wallet') actor: string,
    @CurrentUser('role') callerRole: UserRole,
    @Query('force') force?: string,
  ): Promise<PendingConfigChangeDto | GovernanceConfig> {
    if (force === 'true') {
      return this.governanceService.emergencyConfigUpdate(actor, dto, callerRole);
    }

    return this.governanceService.proposeConfigChange(actor, dto);
  }

  // ── Pending-change management ─────────────────────────────────────────────

  /**
   * GET /governance/config/pending
   * Lists all pending config changes in effectiveAt order.
   */
  @Get('config/pending')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @ApiOperation({ summary: 'List pending protocol config changes (admin)' })
  async getPendingConfigChanges(): Promise<PendingConfigChangeDto[]> {
    return this.governanceService.getPendingConfigChanges();
  }

  /**
   * DELETE /governance/config/pending/:id
   * Cancels a pending config change before it is applied.
   */
  @Delete('config/pending/:id')
  @Roles(UserRole.ADMIN, UserRole.SUPER_ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cancel a pending protocol config change (admin)' })
  async cancelConfigChange(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('wallet') actor: string,
  ): Promise<PendingConfigChangeDto> {
    return this.governanceService.cancelConfigChange(id, actor);
  }

  // ── Proposals ─────────────────────────────────────────────────────────────

  @Get('proposals')
  @Public()
  @ApiOperation({ summary: 'List governance proposals (paginated)' })
  async getProposals(@Query() query: GovernanceQueryDto): Promise<PaginatedResponseDto<Proposal>> {
    const result = await this.governanceService.getProposals(query);
    return PaginatedResponseDto.fromList(result);
  }

  @Get('proposals/:id')
  @Public()
  @ApiOperation({ summary: 'Get a proposal by ID' })
  async getProposalById(@Param('id') id: string): Promise<Proposal> {
    return this.governanceService.getProposalById(id);
  }

  @Post('proposals')
  @Roles(UserRole.ADMIN, UserRole.VERIFIER)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a new governance proposal' })
  async createProposal(
    @CurrentUser('wallet') proposer: string,
    @Body() dto: CreateProposalDto,
  ): Promise<Proposal> {
    return this.governanceService.createProposal(proposer, dto);
  }

  @Post('proposals/:id/vote')
  @Roles(UserRole.ADMIN, UserRole.VERIFIER)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Cast a vote on a proposal' })
  async vote(
    @Param('id') id: string,
    @CurrentUser('wallet') voter: string,
    @Body() dto: VoteDto,
  ): Promise<Proposal> {
    return this.governanceService.vote(id, voter, dto);
  }

  @Post('proposals/:id/execute')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Execute an approved proposal (admin)' })
  async executeProposal(
    @Param('id') id: string,
    @CurrentUser('wallet') executor: string,
  ): Promise<Proposal> {
    return this.governanceService.executeProposal(id, executor);
  }
}
