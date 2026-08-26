import { IsInt, IsNumber, IsOptional, IsString, Max, Min } from 'class-validator';

/**
 * Request body for PATCH /governance/config.
 *
 * All fields are optional — only the ones present are queued for update.
 * The same DTO is used for the normal (timelocked) path and the emergency
 * override (force=true query param, SUPER_ADMIN only).
 */
export class UpdateGovernanceConfigDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000) // 100% in basis points
  protocolFeeBps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minOracleConfirmations?: number;

  @IsOptional()
  @IsInt()
  @Min(60) // minimum 1 minute voting period
  votingPeriod?: number;

  @IsOptional()
  @IsInt()
  @Min(0)
  timelockPeriod?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  quorum?: number;

  /**
   * Percentage-of-eligible-voters quorum in basis points (10000 = 100%).
   * 0 disables the percentage model and falls back to the absolute `quorum`.
   */
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  quorumBasisPoints?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(14) // pH 0–14
  phMin?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(14)
  phMax?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  doThreshold?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  tempPenaltyDelta?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  weightVolumetric?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  weightNitrogen?: number;

  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  weightPhosphorus?: number;

  /** Optional human-readable note explaining why this change is being proposed. */
  @IsOptional()
  @IsString()
  reason?: string;
}
