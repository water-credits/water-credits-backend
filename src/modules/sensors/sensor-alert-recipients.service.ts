import { Injectable, Logger } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { UsersService } from '../users/users.service';
import { UserRole } from '../users/entities/user.entity';

/** Global roles that should be escalated to for every project's sensor alerts. */
const ALERT_ESCALATION_ROLES: UserRole[] = [UserRole.ADMIN, UserRole.VERIFIER];

/**
 * Resolves who should receive a persisted notification for a sensor alert:
 * the owning project's owner, plus every ADMIN/VERIFIER (mirrors the
 * privileged-role set `SensorProjectAccessService` already grants
 * project-wide WS read access to).
 */
export interface AlertRecipient {
  userId: string;
  isOwner: boolean;
  email?: string;
}

@Injectable()
export class SensorAlertRecipientsService {
  private readonly logger = new Logger(SensorAlertRecipientsService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly usersService: UsersService,
  ) {}

  async resolveRecipients(projectId: string): Promise<AlertRecipient[]> {
    const [project, escalationUsers] = await Promise.all([
      this.projectsService.findById(projectId).catch((err) => {
        this.logger.warn(
          `Could not load project ${projectId} while resolving alert recipients: ${(err as Error).message}`,
        );
        return null;
      }),
      this.usersService.findByRoles(ALERT_ESCALATION_ROLES),
    ]);

    const recipients = new Map<string, AlertRecipient>();

    for (const u of escalationUsers) {
      recipients.set(u.id, { userId: u.id, email: u.email ?? undefined, isOwner: false });
    }

    if (project?.ownerId) {
      const owner = await this.usersService.findById(project.ownerId).catch(() => null);
      recipients.set(project.ownerId, { userId: project.ownerId, email: owner?.email ?? undefined, isOwner: true });
    }

    return Array.from(recipients.values());
  }
}
