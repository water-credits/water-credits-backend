import { IsBoolean } from 'class-validator';

/**
 * DTO used exclusively by admin-only endpoints (e.g. PATCH /users/:id/kyc).
 * KYC verification is an integrity check that must be performed by a
 * different admin — it is intentionally NOT part of UpdateUserDto so that
 * no user (including admins) can self-approve their own KYC status.
 */
export class AdminUpdateUserDto {
  @IsBoolean()
  isKycVerified: boolean;
}
