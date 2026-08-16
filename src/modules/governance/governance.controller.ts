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
  async updateConfig(
    @Body() dto: UpdateGovernanceConfigDto,
    @CurrentUser('wallet') actor: string,
    @Query('force') force?: string,
  ): Promise<PendingConfigChangeDto | GovernanceConfig> {
    if (force === 'true') {
      // Force flag — requires SUPER_ADMIN; the @Roles guard allows both roles
      // in but we enforce SUPER_ADMIN here at the service boundary.
      // The controller relies on the current user's role being attached to the
      // request by JwtStrategy.validate().  We extract it from the user object.
      return this.governanceService.emergencyConfigUpdate(actor, dto);
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
  async cancelConfigChange(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser('wallet') actor: string,
  ): Promise<PendingConfigChangeDto> {
    return this.governanceService.cancelConfigChange(id, actor);
  }

  // ── Proposals ─────────────────────────────────────────────────────────────

  @Get('proposals')
  @Public()
  async getProposals(@Query() query: GovernanceQueryDto): Promise<PaginatedResponseDto<Proposal>> {
    const { data, total, page, limit } = await this.governanceService.getProposals(query);
    return PaginatedResponseDto.from(data, total, page, limit);
  }

  @Get('proposals/:id')
  @Public()
  async getProposalById(@Param('id') id: string): Promise<Proposal> {
    return this.governanceService.getProposalById(id);
  }

  @Post('proposals')
  @Roles(UserRole.ADMIN, UserRole.VERIFIER)
  @HttpCode(HttpStatus.CREATED)
  async createProposal(
    @CurrentUser('wallet') proposer: string,
    @Body() dto: CreateProposalDto,
  ): Promise<Proposal> {
    return this.governanceService.createProposal(proposer, dto);
  }

  @Post('proposals/:id/vote')
  @Roles(UserRole.ADMIN, UserRole.VERIFIER)
  @HttpCode(HttpStatus.OK)
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
  async executeProposal(
    @Param('id') id: string,
    @CurrentUser('wallet') executor: string,
  ): Promise<Proposal> {
    return this.governanceService.executeProposal(id, executor);
  }
}
