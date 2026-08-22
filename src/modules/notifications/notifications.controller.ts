import { Controller, Get, Patch, Param, UseGuards, Query } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiBearerAuth } from '@nestjs/swagger';
import { NotificationsService } from './notifications.service';
import { JwtAuthGuard } from '../../common/guards/jwt-auth.guard';
import { CurrentUser } from '../../common/decorators/current-user.decorator';
import { PaginationDto } from '../../common/dto/pagination.dto';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';
import { Notification } from './entities/notification.entity';

@ApiTags('notifications')
@ApiBearerAuth()
@Controller('notifications')
@UseGuards(JwtAuthGuard)
export class NotificationsController {
  constructor(private readonly notificationsService: NotificationsService) {}

  @Get()
  @ApiOperation({
    summary: 'List the current user notifications',
    description:
      'Supports offset (?page=&limit=) and keyset (?cursor=&limit=) pagination. ' +
      'Prefer the cursor returned in meta.nextCursor for stable paging under a live feed.',
  })
  async getNotifications(
    @CurrentUser('id') userId: string,
    @Query() pagination: PaginationDto,
  ): Promise<PaginatedResponseDto<Notification>> {
    const result = await this.notificationsService.getNotifications(userId, pagination);
    return PaginatedResponseDto.fromList(result);
  }

  @Patch(':id/read')
  @ApiOperation({ summary: 'Mark a notification as read' })
  async markAsRead(@Param('id') id: string, @CurrentUser('id') userId: string) {
    return this.notificationsService.markAsRead(id, userId);
  }

  @Patch('read-all')
  @ApiOperation({ summary: 'Mark all notifications as read' })
  async markAllAsRead(@CurrentUser('id') userId: string) {
    return this.notificationsService.markAllAsRead(userId);
  }
}
