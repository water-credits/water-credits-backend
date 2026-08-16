import { GovernanceConfigChange, ConfigChangeStatus } from '../entities/governance-config-change.entity';

/**
 * Public-facing representation of a pending (or historical) config change.
 * Strips the internal `config` relation to keep responses lean.
 */
export class PendingConfigChangeDto {
  id: string;
  configId: number;
  proposedValues: Record<string, unknown>;
  proposedBy: string;
  effectiveAt: Date;
  status: ConfigChangeStatus;
  appliedAt: Date | null;
  appliedBy: string | null;
  cancelledAt: Date | null;
  cancelledBy: string | null;
  reason: string | null;
  createdAt: Date;

  static fromEntity(entity: GovernanceConfigChange): PendingConfigChangeDto {
    const dto = new PendingConfigChangeDto();
    dto.id = entity.id;
    dto.configId = entity.configId;
    dto.proposedValues = entity.proposedValues as Record<string, unknown>;
    dto.proposedBy = entity.proposedBy;
    dto.effectiveAt = entity.effectiveAt;
    dto.status = entity.status;
    dto.appliedAt = entity.appliedAt;
    dto.appliedBy = entity.appliedBy;
    dto.cancelledAt = entity.cancelledAt;
    dto.cancelledBy = entity.cancelledBy;
    dto.reason = entity.reason;
    dto.createdAt = entity.createdAt;
    return dto;
  }
}
