import { ForbiddenException } from '@nestjs/common';
import { ProjectsService } from '../projects/projects.service';
import { UserRole } from '../users/entities/user.entity';
import { SensorProjectAccessService } from './sensor-project-access.service';

describe('SensorProjectAccessService', () => {
  let projectsService: { findById: jest.Mock };
  let service: SensorProjectAccessService;

  beforeEach(() => {
    projectsService = { findById: jest.fn() };
    service = new SensorProjectAccessService(projectsService as unknown as ProjectsService);
  });

  it('allows a project owner to access their own sensor data', async () => {
    projectsService.findById.mockResolvedValue({ id: 'project-a', ownerId: 'user-a' });

    await expect(
      service.assertProjectAccess('user-a', UserRole.FARMER, 'project-a'),
    ).resolves.toBeUndefined();
  });

  it('rejects a different user from accessing a project', async () => {
    projectsService.findById.mockResolvedValue({ id: 'project-b', ownerId: 'user-b' });

    await expect(
      service.assertProjectAccess('user-a', UserRole.FARMER, 'project-b'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('allows the established admin, verifier, and oracle roles without a project lookup', async () => {
    for (const role of [UserRole.ADMIN, UserRole.VERIFIER, UserRole.ORACLE]) {
      await expect(
        service.assertProjectAccess('operator', role, 'project-b'),
      ).resolves.toBeUndefined();
    }

    expect(projectsService.findById).not.toHaveBeenCalled();
  });
});
