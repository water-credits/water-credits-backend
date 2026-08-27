import {
  IsInt,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  Min,
  registerDecorator,
  ValidatorConstraint,
  ValidatorConstraintInterface,
  ValidationArguments,
  ValidationOptions,
} from 'class-validator';
import { UnprocessableEntityException } from '@nestjs/common';

export const WEIGHT_SUM_TOLERANCE = 0.001;

export function computeEffectiveWeights(
  current: { weightVolumetric: number; weightNitrogen: number; weightPhosphorus: number },
  updates: { weightVolumetric?: number; weightNitrogen?: number; weightPhosphorus?: number },
): { weightVolumetric: number; weightNitrogen: number; weightPhosphorus: number } {
  return {
    weightVolumetric:
      updates.weightVolumetric !== undefined ? updates.weightVolumetric : current.weightVolumetric,
    weightNitrogen:
      updates.weightNitrogen !== undefined ? updates.weightNitrogen : current.weightNitrogen,
    weightPhosphorus:
      updates.weightPhosphorus !== undefined ? updates.weightPhosphorus : current.weightPhosphorus,
  };
}

export function validateWeightsSum(
  weights: { weightVolumetric: number; weightNitrogen: number; weightPhosphorus: number },
  tolerance = WEIGHT_SUM_TOLERANCE,
): { ok: boolean; sum: number; message?: string } {
  const sum = weights.weightVolumetric + weights.weightNitrogen + weights.weightPhosphorus;
  const diff = Math.abs(sum - 1.0);
  if (diff <= tolerance) {
    return { ok: true, sum };
  }
  return {
    ok: false,
    sum,
    message:
      `Credit weights must sum to 1.0 (tolerance ±${tolerance}); ` +
      `got weightVolumetric=${weights.weightVolumetric} + ` +
      `weightNitrogen=${weights.weightNitrogen} + ` +
      `weightPhosphorus=${weights.weightPhosphorus} = ${sum.toFixed(6)}`,
  };
}

export function assertWeightsSum(
  current: { weightVolumetric: number; weightNitrogen: number; weightPhosphorus: number },
  updates: { weightVolumetric?: number; weightNitrogen?: number; weightPhosphorus?: number },
): void {
  const hasWeightUpdate =
    updates.weightVolumetric !== undefined ||
    updates.weightNitrogen !== undefined ||
    updates.weightPhosphorus !== undefined;
  if (!hasWeightUpdate) {
    return;
  }
  const effective = computeEffectiveWeights(current, updates);
  const check = validateWeightsSum(effective);
  if (!check.ok) {
    throw new UnprocessableEntityException(check.message);
  }
}

@ValidatorConstraint({ name: 'WeightSumConstraint', async: false })
class WeightSumConstraint implements ValidatorConstraintInterface {
  validate(_value: unknown, args: ValidationArguments): boolean {
    const obj = (args.object || {}) as Record<string, unknown>;
    const wv = obj.weightVolumetric;
    const wn = obj.weightNitrogen;
    const wp = obj.weightPhosphorus;

    if (wv === undefined && wn === undefined && wp === undefined) {
      return true;
    }

    // Partial updates are valid at the DTO layer. The service validates the
    // effective values against the persisted configuration. When all three
    // weights are supplied, validate their sum here as a class-level invariant.
    if (wv === undefined || wn === undefined || wp === undefined) {
      return true;
    }

    if (typeof wv !== 'number' || typeof wn !== 'number' || typeof wp !== 'number') {
      return false;
    }

    const result = validateWeightsSum(
      { weightVolumetric: wv, weightNitrogen: wn, weightPhosphorus: wp },
      WEIGHT_SUM_TOLERANCE,
    );
    return result.ok;
  }

  defaultMessage(args: ValidationArguments): string {
    const obj = (args.object || {}) as Record<string, unknown>;
    const wv = Number(obj.weightVolumetric ?? 0);
    const wn = Number(obj.weightNitrogen ?? 0);
    const wp = Number(obj.weightPhosphorus ?? 0);
    const sum = wv + wn + wp;
    return (
      `weightVolumetric + weightNitrogen + weightPhosphorus must sum to 1.0 ` +
      `(±${WEIGHT_SUM_TOLERANCE}). Got ${wv} + ${wn} + ${wp} = ${sum.toFixed(6)}.`
    );
  }
}

function ValidateCreditWeights(validationOptions?: ValidationOptions): ClassDecorator {
  return ((target: unknown) => {
    registerDecorator({
      name: 'ValidateCreditWeights',
      target: target as never,
      propertyName: undefined as unknown as string,
      options: validationOptions,
      constraints: [],
      validator: WeightSumConstraint,
    });
  }) as ClassDecorator;
}

@ValidateCreditWeights({
  message: 'weightVolumetric + weightNitrogen + weightPhosphorus must sum to 1.0 (±0.001).',
})
export class UpdateGovernanceConfigDto {
  @IsOptional()
  @IsInt()
  @Min(0)
  @Max(10_000)
  protocolFeeBps?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  minOracleConfirmations?: number;

  @IsOptional()
  @IsInt()
  @Min(60)
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
  @Max(14)
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

  @IsOptional()
  @IsString()
  reason?: string;
}
