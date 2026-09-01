import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { BullModule } from '@nestjs/bull';
import { CreditsController } from './credits.controller';
import { CreditsService } from './credits.service';
import { CreditsRetirementProcessor } from './credits-retirement.processor';
import { CertificateService } from './certificate.service';
import { Retirement } from './entities/retirement.entity';
import { Project } from '../projects/entities/project.entity';
import { User } from '../users/entities/user.entity';
import { NotificationsModule } from '../notifications/notifications.module';
import { ProjectsModule } from '../projects/projects.module';
import { UsersModule } from '../users/users.module';

@Module({
  imports: [
    TypeOrmModule.forFeature([Retirement, Project, User]),
    BullModule.registerQueue({
      name: 'retirements',
      defaultJobOptions: {
        attempts: 5,
        backoff: {
          type: 'fixed',
          delay: 30000,
        },
        removeOnComplete: 100,
      },
    }),
    NotificationsModule,
    // Provides ProjectsService and the Project repository for on-chain
    // credit lookups (creditTokenAddress) and active-project counts.
    ProjectsModule,
    UsersModule,
  ],
  controllers: [CreditsController],
  providers: [CreditsService, CreditsRetirementProcessor, CertificateService],
  exports: [CreditsService, TypeOrmModule],
})
export class CreditsModule {}
