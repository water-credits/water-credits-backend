# Fix: Sensor-ingestion queue → WebSocket fan-out (sensor:reading / sensor:alert)

## Issue

`SensorsIngestionProcessor` (Bull queue `sensor-ingestion`) was a stub, and
`SensorsService.ingestReading()` never enqueued jobs — so the queue/processor
were dead code, and the live dashboard never received `sensor:reading` /
`sensor:alert` WebSocket events from the ingestion path.

## Root causes

1. `SensorsService.ingestReading()` saved the reading but never called
   `sensorIngestionQueue.add(...)`.
2. `SensorsIngestionProcessor.processReading()` only logged.
3. No idempotency guard existed, so Bull retries (5 attempts, exponential
   backoff) would double-emit events.
4. Alert thresholds were not governance-controlled (no access to
   `GovernanceConfig.phMin / phMax / doThreshold`).

## Fix

### 1. Enqueue after save — `sensors.service.ts`
- Injected `@InjectQueue('sensor-ingestion')`.
- After persisting the reading (and updating device/batch), adds the job
  **without a name** so it lands on Bull's default `'__default__'` queue —
  exactly what the unnamed `@Process({ concurrency: 5 })` handler subscribes
  to (verified against `@nestjs/bull` internals).
- Job payload: `{ readingId, deviceId, projectId }`.

### 2. Implement the processor — `sensors-ingestion.processor.ts`
`processReading()` now:
1. Loads the `SensorReading` by `readingId` (skips gracefully if missing).
2. **Idempotency guard**: skips if `wsEmittedAt` is already set (retry-safe).
3. Calls `SensorsGateway.emitReading(projectId, payload)` → `sensor:reading`.
4. Evaluates every numeric parameter against thresholds and calls
   `SensorsGateway.emitAlert(...)` → `sensor:alert` for each breach with
   `{ projectId, deviceId, parameter, value, threshold, direction }`
   (`direction`: `'below'` | `'above'`).
5. Stamps + persists `wsEmittedAt` so retries are no-ops.

Thresholds are **governance-controlled** with hardcoded fallbacks:
- `ph.min` ← `GovernanceConfig.phMin ?? 6.0`, `ph.max` ← `phMax ?? 9.0`
- `dissolvedOxygen.min` ← `doThreshold ?? 5.0`
- Others fall back to physical plausibility ranges
  (turbidity/flowRate/nitrogen/phosphorus ≥ 0, temperature −50…100).
- Config load failure degrades gracefully to the same fallbacks.
- TypeORM `decimal` columns return strings — values are coerced with `Number()`.

### 3. Idempotency column — `sensor-reading.entity.ts` + migration
- Added nullable `ws_emitted_at TIMESTAMPTZ` column.
- New migration `013_add_sensor_reading_ws_emitted_at.sql`.

### 4. Module wiring — `sensors.module.ts` (avoids circular dependency)
- Added `GovernanceConfig` to `TypeOrmModule.forFeature([...])` so the
  processor gets the config repository directly — same pattern as
  `OracleModule`; no need to import `GovernanceModule` (which would risk the
  `Sensors → Governance` cycle the issue warns about).
- `SensorsGateway` was already a provider in `SensorsModule`, so it is injected
  directly.

## Tests

- New `sensors-ingestion.processor.spec.ts` (13 tests):
  successful emit + `wsEmittedAt` persist · no alerts for in-range · null/undefined
  params skipped · pH below `phMin` → `sensor:alert` · pH above `phMax` →
  `sensor:alert` · DO below `doThreshold` → `sensor:alert` · one alert per
  breached parameter · hardcoded fallback when no config row · config-read
  failure falls back · **no double-emit on retry** (twice) · missing reading skips.
- Updated `sensors.service.spec.ts`: queue mock injected in all 5 test modules;
  new test asserts `ingestReading()` enqueues `{ readingId, deviceId, projectId }`.

## Validation

- `jest`: **425 passed** (34 suites) — includes 14 new tests.
- `npm run build`: **exit 0**.
- `eslint` + `prettier --check` on changed files: clean.
- Processor coverage: **96.4% stmts / 100% funcs**.

## Files changed / added

| File | Change |
|---|---|
| `src/modules/sensors/sensors.service.ts` | Inject queue; enqueue job after save |
| `src/modules/sensors/sensors-ingestion.processor.ts` | Full implementation (was stub) |
| `src/modules/sensors/entities/sensor-reading.entity.ts` | Added `wsEmittedAt` column |
| `src/modules/sensors/sensors.module.ts` | Register `GovernanceConfig` repo |
| `src/modules/sensors/sensors-ingestion.processor.spec.ts` | **New** — 13 processor tests |
| `src/modules/sensors/sensors.service.spec.ts` | Queue mocks + enqueue assertion |
| `src/migrations/013_add_sensor_reading_ws_emitted_at.sql` | **New** — `ws_emitted_at` column |
