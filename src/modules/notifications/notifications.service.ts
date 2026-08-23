import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Notification, NotificationType } from './entities/notification.entity';
import { NotificationsGateway } from './notifications.gateway';
import { paginate, PaginatedList, PaginationParams } from '../../common/pagination';

@Injectable()
export class NotificationsService {
  private readonly logger = new Logger(NotificationsService.name);

  constructor(
    @InjectRepository(Notification)
    private readonly notificationRepository: Repository<Notification>,
    private readonly notificationsGateway: NotificationsGateway,
  ) {}

  async createNotification(
    userId: string,
    type: NotificationType,
    title: string,
    message: string,
    metadata?: Record<string, unknown>,
  ): Promise<Notification> {
    const notification = this.notificationRepository.create({
      userId,
      type,
      title,
      message,
      metadata,
    });

    const savedNotification = await this.notificationRepository.save(notification);

    // Emit via WebSocket
    this.notificationsGateway.sendToUser(userId, type, {
      id: savedNotification.id,
      title,
      message,
      metadata,
      createdAt: savedNotification.createdAt,
    });

    return savedNotification;
  }

  /**
   * List a user's notifications, newest first.
   *
   * Supports both offset (`page`/`limit`) and keyset (`cursor`/`limit`)
   * pagination via the shared `paginate()` helper, keeping the notification
   * feed consistent under the steady stream of concurrent inserts it receives.
   */
  async getNotifications(
    userId: string,
    params: PaginationParams = {},
  ): Promise<PaginatedList<Notification>> {
    const qb = this.notificationRepository
      .createQueryBuilder('notification')
      .where('notification.user_id = :userId', { userId });

    return paginate(
      qb,
      { alias: 'notification', sortColumn: 'notification.created_at', sortProperty: 'createdAt' },
      params,
    );
  }

  async markAsRead(notificationId: string, userId: string) {
    return this.notificationRepository.update({ id: notificationId, userId }, { isRead: true });
  }

  async markAllAsRead(userId: string) {
    return this.notificationRepository.update({ userId, isRead: false }, { isRead: true });
  }

  // Broadcasters for specific events as requested in Day 9
  async notifySensorReading(userId: string, projectId: string, reading: Record<string, unknown>) {
    return this.createNotification(
      userId,
      NotificationType.SENSOR_READING,
      'New Sensor Reading',
      `Project ${projectId} received a new reading.`,
      { projectId, reading },
    );
  }

  async notifySensorAlert(userId: string, projectId: string, alert: Record<string, unknown>) {
    return this.createNotification(
      userId,
      NotificationType.SENSOR_ALERT,
      'Sensor Alert',
      this.buildSensorAlertMessage(projectId, alert),
      { projectId, alert },
    );
  }

  private buildSensorAlertMessage(projectId: string, alert: Record<string, unknown>): string {
    if (alert.parameter === 'staleness') {
      const minutes = alert.staleMinutes as number | undefined;
      return `Device ${alert.deviceId} on project ${projectId} has not reported ${
        minutes !== undefined ? `in over ${minutes} minutes` : 'recently'
      }.`;
    }
    return `Device ${alert.deviceId} on project ${projectId} reported ${alert.parameter}=${alert.value}, ${alert.direction} threshold ${alert.threshold}.`;
  }

  async notifyCreditMinted(userId: string, projectId: string, amount: number) {
    return this.createNotification(
      userId,
      NotificationType.CREDIT_MINTED,
      'Credits Minted',
      `Successfully minted ${amount} credits for project ${projectId}.`,
      { projectId, amount },
    );
  }

  async notifyCreditRetired(userId: string, projectId: string, amount: number) {
    return this.createNotification(
      userId,
      NotificationType.CREDIT_RETIRED,
      'Credits Retired',
      `Successfully retired ${amount} credits for project ${projectId}.`,
      { projectId, amount },
    );
  }
}
