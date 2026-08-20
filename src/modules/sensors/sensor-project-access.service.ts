import { ForbiddenException, Injectable } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { UserRole } from '../users/entities/user.entity';

export const PRIVILEGED_SENSOR_ROLES = new Set<string>([
  UserRole.ADMIN,
  UserRole.VERIFIER,
  UserRole.ORACLE,
]);

@Injectable()
export class SensorProjectAccessService {
  constructor(private readonly projectsService: ProjectsService) {}

  isPrivileged(role?: string): boolean {
    return Boolean(role && PRIVILEGED_SENSOR_ROLES.has(role));
  }

  requirePrivilegedRole(role?: string): void {
    if (!this.isPrivileged(role)) {
      throw new ForbiddenException('Project-scoped sensor access is required');
    }
  }

  async assertProjectAccess(
    userId: string,
    role: string | undefined,
    projectId: string,
  ): Promise<void> {
    if (this.isPrivileged(role)) {
      return;
    }

    const project = await this.projectsService.findById(projectId);
    if (project.ownerId !== userId) {
      throw new ForbiddenException('You do not have access to this project');
    }
  }

  async canAccessProject(
    userId: string | undefined,
    role: string | undefined,
    projectId: string,
  ): Promise<boolean> {
    if (!userId) {
      return false;
    }

    try {
      await this.assertProjectAccess(userId, role, projectId);
      return true;
    } catch {
      return false;
    }
  }
}
