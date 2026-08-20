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
import { ApiTags, ApiOperation, ApiBearerAuth, ApiSecurity } from '@nestjs/swagger';
import { SensorsService } from './sensors.service';
import { CreateReadingDto } from './dto/create-reading.dto';
import { QueryReadingsDto } from './dto/query-readings.dto';
import { RegisterDeviceDto } from './dto/register-device.dto';
import { Public } from '../../common/decorators/public.decorator';
import { ApiKeyAuth as ApiKeyAuthMetadata } from '../../common/decorators/api-key-auth.decorator';
import { ApiKeyGuard } from '../../common/guards/api-key.guard';
import { SensorReading } from './entities/sensor-reading.entity';
import { SensorDevice } from './entities/sensor-device.entity';
import { PaginatedResponseDto } from '../../common/dto/api-response.dto';
import { ThrottleSensor } from '../../common/decorators/throttle.decorator';
import { CurrentUser } from '../../common/decorators/current-user.decorator';

@ApiTags('sensors')
@ApiBearerAuth()
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
  @ApiKeyAuthMetadata()
  @ApiSecurity('api-key')
  @UseGuards(ApiKeyGuard)
  @ThrottleSensor()
  @ApiOperation({ summary: 'Ingest a sensor reading (API key auth)' })
  @HttpCode(HttpStatus.CREATED)
  async ingestReading(@Body() dto: CreateReadingDto): Promise<SensorReading> {
    return this.sensorsService.ingestReading(dto);
  }

  @Get('readings')
  @ApiOperation({ summary: 'List sensor readings (paginated)' })
  async getReadings(
    @Query() query: QueryReadingsDto,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role?: string,
  ): Promise<PaginatedResponseDto<SensorReading>> {
    const { data, total, page, limit } = await this.sensorsService.getReadings(query, userId, role);
    return PaginatedResponseDto.from(data, total, page, limit);
  }

  @Get('readings/latest')
  @ApiOperation({ summary: 'Get the latest reading (optionally per device)' })
  async getLatestReading(
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role: string | undefined,
    @Query('deviceId') deviceId?: string,
  ): Promise<SensorReading | SensorReading[]> {
    return this.sensorsService.getLatestReading(userId, role, deviceId);
  }

  @Get('readings/summary')
  @ApiOperation({ summary: 'Get aggregated summary metrics for a project' })
  async getAggregatedSummary(
    @Query('projectId') projectId: string,
    @Query('startDate') startDate?: string,
    @Query('endDate') endDate?: string,
  ): Promise<Record<string, number | null>> {
    return this.sensorsService.getAggregatedSummary(projectId, startDate, endDate);
  }

  @Post('devices')
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Register a new sensor device' })
  async registerDevice(
    @Body() dto: RegisterDeviceDto,
  ): Promise<SensorDevice & { apiKeyPlaintext: string }> {
    return this.sensorsService.registerDevice(dto.projectId, dto);
  }

  @Get('devices')
  @ApiOperation({ summary: 'List sensor devices (optionally per project)' })
  async getDevices(
    @Query('projectId') projectId: string | undefined,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role?: string,
  ): Promise<SensorDevice[]> {
    return this.sensorsService.getDevices(projectId, userId, role);
  }

  @Get('devices/:id')
  @ApiOperation({ summary: 'Get a sensor device by ID' })
  async getDeviceById(
    @Param('id') id: string,
    @CurrentUser('id') userId: string,
    @CurrentUser('role') role?: string,
  ): Promise<SensorDevice> {
    return this.sensorsService.getDeviceById(id, userId, role);
  }
}
