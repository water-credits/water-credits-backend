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
@Injectable()
export class SensorAlertRecipientsService {
  private readonly logger = new Logger(SensorAlertRecipientsService.name);

  constructor(
    private readonly projectsService: ProjectsService,
    private readonly usersService: UsersService,
  ) {}

  async resolveRecipients(projectId: string): Promise<string[]> {
    const [project, escalationUsers] = await Promise.all([
      this.projectsService.findById(projectId).catch((err) => {
        this.logger.warn(
          `Could not load project ${projectId} while resolving alert recipients: ${(err as Error).message}`,
        );
        return null;
      }),
      this.usersService.findByRoles(ALERT_ESCALATION_ROLES),
    ]);

    const ids = new Set<string>(escalationUsers.map((u) => u.id));
    if (project?.ownerId) {
      ids.add(project.ownerId);
    }
    return Array.from(ids);
  }
}
