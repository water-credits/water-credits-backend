import { IsString, IsOptional, IsObject, IsUUID } from 'class-validator';

export class TriggerSubmissionDto {
  @IsString()
  projectId: string;

  @IsString()
  oracleAddress: string;

  @IsOptional()
  @IsUUID()
  batchId?: string;

  @IsOptional()
  @IsObject()
  readings?: Record<string, number>;
}
