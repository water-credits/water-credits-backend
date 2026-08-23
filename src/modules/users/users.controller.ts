import { Controller, Get, Patch, Param, Body, Query, HttpCode, HttpStatus } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { UsersService } from './users.service';
import { UpdateUserDto } from './dto/update-user.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { AdminUpdateUserDto } from './dto/admin-update-user.dto';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { Roles } from '../../common/decorators/roles.decorator';
import { User, UserRole } from './entities/user.entity';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';

@ApiTags('users')
@ApiBearerAuth()
@Controller('users')
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Get('me')
  @ApiOperation({ summary: 'Get the current user profile' })
  async getProfile(@CurrentUser() user: User): Promise<User> {
    return user;
  }

  @Patch('me')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Update the current user profile' })
  async updateProfile(
    @CurrentUser('id') userId: string,
    @Body() dto: UpdateUserDto,
  ): Promise<User> {
    return this.usersService.updateProfile(userId, dto);
  }

  @Get()
  @Roles(UserRole.ADMIN)
  @ApiOperation({ summary: 'List all users (paginated)' })
  async findAll(@Query() pagination: PaginationDto): Promise<PaginatedResponseDto<User>> {
    const result = await this.usersService.findAll(pagination);
    return PaginatedResponseDto.fromList(result);
  }

  @Patch(':id/kyc')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Set a user KYC verification status (admin only)' })
  async updateKyc(
    @CurrentUser('id') actorUserId: string,
    @Param('id') id: string,
    @Body() dto: AdminUpdateUserDto,
  ): Promise<User> {
    return this.usersService.updateKycStatus(actorUserId, id, dto);
  }

  @Patch(':id/role')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Change a user role' })
  async updateRole(
    @CurrentUser('id') actorUserId: string,
    @Param('id') id: string,
    @Body() dto: UpdateRoleDto,
  ): Promise<User> {
    return this.usersService.updateRole(actorUserId, id, dto);
  }

  @Patch(':id/deactivate')
  @Roles(UserRole.ADMIN)
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Soft-delete (deactivate) a user' })
  async deactivate(@CurrentUser('id') actorUserId: string, @Param('id') id: string): Promise<void> {
    return this.usersService.softDelete(actorUserId, id);
  }
}
