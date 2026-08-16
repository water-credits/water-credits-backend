import { IsString, IsEnum, IsDateString, IsOptional } from 'class-validator';

export enum TimeSeriesBucket {
  HOUR = 'hour',
  DAY = 'day',
  WEEK = 'week',
  MONTH = 'month',
}

export enum SensorParameter {
  PH = 'ph',
  TURBIDITY = 'turbidity',
  DISSOLVED_OXYGEN = 'dissolvedOxygen',
  FLOW_RATE = 'flowRate',
  NITROGEN = 'nitrogen',
  PHOSPHORUS = 'phosphorus',
  TEMPERATURE = 'temperature',
}

export class TimeSeriesQueryDto {
  @IsEnum(SensorParameter, {
    message: 'parameter must be one of: ph, turbidity, dissolvedOxygen, flowRate, nitrogen, phosphorus, temperature',
  })
  parameter: SensorParameter;

  @IsEnum(TimeSeriesBucket, {
    message: 'bucket must be one of: hour, day, week, month',
  })
  bucket: TimeSeriesBucket;

  @IsDateString()
  startDate: string;

  @IsDateString()
  endDate: string;
}
