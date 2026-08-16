import {
  Controller,
  Get,
  Post,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  UseGuards,
} from '@nestjs/common';
import { SensorsService } from './sensors.service';
import { CreateReadingDto } from './dto/create-reading.dto';
import { QueryReadingsDto } from './dto/query-readings.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { TimeSeriesQueryDto } from './dto/time-series-query.dto';
import { Public } from '../../common/decorators/public.decorator';
import { ApiKeyAuth } from '../../common/decorators/api-key-auth.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { SensorReading } from './entities/sensor-reading.entity';
import { SensorDevice } from './entities/sensor-device.entity';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';
import { ThrottleSensor } from '../../common/decorators/throttle.decorator';

@Controller('sensors')
export class SensorsController {
  constructor(private readonly sensorsService: SensorsService) {}

  /**
   * Ingest a sensor reading from a registered device.
   *
   * Authentication: per-device API key via X-API-Key header.
   * The key is validated by ApiKeyGuard against the bcrypt hash stored on the
   * SensorDevice entity.  JWT is not required (@Public bypasses JwtAuthGuard).
   */
  @Post('readings')
  @Public()
  @ApiKeyAuth()
  @UseGuards(ApiKeyGuard)
  @ThrottleSensor()
  @HttpCode(HttpStatus.CREATED)
  async ingestReading(@Body() dto: CreateReadingDto): Promise<SensorReading> {
    return this.sensorsService.ingestReading(dto);
  }

  @Get('readings')
  async getReadings(
    @Query() query: QueryReadingsDto,
  ): Promise<PaginatedResponseDto<SensorReading>> {
    const { data, total, page, limit } = await this.sensorsService.getReadings(query);
    return PaginatedResponseDto.from(data, total, page, limit);
  }

  @Get('readings/latest')
  async getLatestReading(
    @Query('deviceId') deviceId?: string,
  ): Promise<SensorReading | SensorReading[]> {
    return this.sensorsService.getLatestReading(deviceId);
  }

  @Get('readings/summary')
  async getAggregatedSummary(
    @Query('projectId') projectId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<Record<string, number | null>> {
    return this.sensorsService.getAggregatedSummary(projectId, startDate, endDate);
  }

  @Post('devices')
  @HttpCode(HttpStatus.CREATED)
  async registerDevice(
    @Body() dto: RegisterDeviceDto,
  ): Promise<SensorDevice & { apiKeyPlaintext: string }> {
    return this.sensorsService.registerDevice(dto.projectId, dto);
  }

  @Get('devices')
  async getDevices(@Query('projectId') projectId?: string): Promise<SensorDevice[]> {
    return this.sensorsService.getDevices(projectId);
  }

  @Get('devices/:id')
  async getDeviceById(@Param('id') id: string): Promise<SensorDevice> {
    return this.sensorsService.getDeviceById(id);
  }

  /**
   * Get time-series aggregated sensor data for a project.
   * 
   * Returns bucketed aggregations (avg, min, max, count) for a specific parameter
   * over a time range. Uses PostgreSQL DATE_TRUNC for efficient time-bucketing.
   * 
   * @param projectId - The project ID to filter readings
   * @param query - Time series query parameters (parameter, bucket, startDate, endDate)
   * @returns Object containing data array, truncated flag, and total count
   */
  @Get('projects/:projectId/time-series')
  async getTimeSeries(
    @Param('projectId') projectId: string,
    @Query() query: TimeSeriesQueryDto,
  ): Promise<{
    data: Array<{ bucket: string; avg: number; min: number; max: number; count: number }>;
    truncated: boolean;
    total: number;
  }> {
    return this.sensorsService.getTimeSeriesData(projectId, query);
  }
}
