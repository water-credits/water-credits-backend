import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { AnalyticsService } from './analytics.service';
import { AnalyticsController } from './analytics.controller';
import { RedisCacheService } from './redis-cache.service';
import { Project } from '../projects/entities/project.entity';
import { Retirement } from '../credits/entities/retirement.entity';
import { ReadingBatch } from '../sensors/entities/reading-batch.entity';
import { User } from '../users/entities/user.entity';

@Module({
  imports: [TypeOrmModule.forFeature([Project, Retirement, ReadingBatch, User])],
  controllers: [AnalyticsController],
  providers: [AnalyticsService, RedisCacheService],
  exports: [AnalyticsService, RedisCacheService],
})
export class AnalyticsModule {}
