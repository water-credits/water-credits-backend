<div align="center">

# 🖥️ water-credits-backend

### *NestJS API server for the Water Quality & Replenishment Credits protocol*

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![NestJS](https://img.shields.io/badge/NestJS-10.3-E0234E)](https://nestjs.com)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6)](https://typescriptlang.org)
[![PostgreSQL](https://img.shields.io/badge/PostgreSQL-15-4169E1)](https://postgresql.org)

**The off-chain orchestration layer — manages users, ingests sensor data, schedules oracle submissions, and serves the Angular frontend.**

</div>

---

## 📋 Table of Contents

- [Overview](#-overview)
- [Architecture](#-architecture)
- [Module Reference](#-module-reference)
  - [Auth Module](#1-auth-module)
  - [Users Module](#2-users-module)
  - [Projects Module](#3-projects-module)
  - [Sensors Module](#4-sensors-module)
  - [Credits Module](#5-credits-module)
  - [Oracle Module](#6-oracle-module)
  - [Governance Module](#7-governance-module)
  - [Analytics Module](#8-analytics-module)
  - [Notifications Module](#9-notifications-module)
- [Database Schema](#-database-schema)
- [API Reference](#-api-reference)
- [Queue Architecture](#-queue-architecture)
- [Stellar Integration](#-stellar-integration)
- [WebSocket Events](#-websocket-events)
- [Authentication Flow](#-authentication-flow)
- [Environment Configuration](#-environment-configuration)
- [Deployment Guide](#-deployment-guide)
- [Testing Strategy](#-testing-strategy)
- [Monitoring & Observability](#-monitoring--observability)
- [Security](#-security)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [Contact](#-contact)
- [License](#-license)

---

## 🌊 Overview

The backend handles **everything off-chain** that the Soroban contracts don't need to worry about. It acts as:

- **API Gateway** — REST endpoints for the Angular frontend
- **Data Pipeline** — Receives sensor readings, validates them, queues them for on-chain submission
- **User Manager** — Authentication via Stellar wallets, role-based access control
- **Orchestrator** — Coordinates the credit lifecycle across multiple Soroban contracts
- **Indexer** — Listens to on-chain events and stores indexed data in PostgreSQL
- **Scheduler** — Cron jobs for oracle submissions, certificate generation, data aggregation

### What This Backend Is NOT

- ❌ **Not a blockchain node** — It talks to Stellar via RPC, it doesn't validate blocks
- ❌ **Not a wallet** — User private keys never touch this server
- ❌ **Not a data source of truth** — Final settlement happens on Soroban; this is a cache/indexer

---

## 🏗️ Architecture

### High-Level Design

```
┌────────────────────────────────────────────────────────────────────────┐
│                           NestJS Application                            │
│                                                                         │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Middleware Pipeline                           │   │
│  │  Helmet │ CORS │ Rate Limiter │ Request Logger │ Auth Guard │   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Controller Layer                              │   │
│  │  ┌───────┐ ┌────────┐ ┌────────┐ ┌────────┐ ┌──────┐ ┌──────┐  │   │
│  │  │ Auth  │ │ Users  │ │Project │ │ Sensor │ │Credit│ │Oracle│  │   │
│  │  │ Ctrl  │ │ Ctrl   │ │ Ctrl   │ │ Ctrl   │ │ Ctrl │ │ Ctrl │  │   │
│  │  └───────┘ └────────┘ └────────┘ └────────┘ └──────┘ └──────┘  │   │
│  │  ┌────────┐ ┌────────┐ ┌─────────────────────────────┐          │   │
│  │  │Govern. │ │Analyt. │ │ WebSocket Gateway (sensors) │          │   │
│  │  │ Ctrl   │ │ Ctrl   │ │                              │          │   │
│  │  └────────┘ └────────┘ └─────────────────────────────┘          │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                       Service Layer                               │   │
│  │  ┌────────┐ ┌────────┐ ┌────────────────┐ ┌─────────────────┐   │   │
│  │  │ Auth   │ │ Project│ │ Sensor         │ │ Credit          │   │   │
│  │  │ Service│ │ Service│ │ Service        │ │ Service         │   │   │
│  │  └────────┘ └────────┘ └────────────────┘ └─────────────────┘   │   │
│  │  ┌────────┐ ┌────────┐ ┌────────────────┐ ┌─────────────────┐   │   │
│  │  │ Oracle │ │Govern. │ │ Stellar        │ │ Notification    │   │   │
│  │  │ Service│ │Service │ │ Service        │ │ Service         │   │   │
│  │  └────────┘ └────────┘ └────────────────┘ └─────────────────┘   │   │
│  └─────────────────────────────────────────────────────────────────┘   │
│                                    │                                    │
│  ┌─────────────────────────────────────────────────────────────────┐   │
│  │                     Integration Layer                             │   │
│  │  ┌─────────────┐ ┌──────────────┐ ┌──────────────────────────┐  │   │
│  │  │ TypeORM     │ │ Bull Queue   │ │ Stellar SDK (Soroban)    │  │   │
│  │  │ (PostgreSQL)│ │ (Redis)      │ │ (RPC + event streaming)  │  │   │
│  │  └─────────────┘ └──────────────┘ └──────────────────────────┘  │   │
│  └─────────────────────────────────────────────────────────────────┘   │
└────────────────────────────────────────────────────────────────────────┘
```

### Directory Structure

```
src/
├── main.ts                              # Application bootstrap
├── app.module.ts                        # Root module imports
│
├── common/                              # Cross-cutting concerns
│   ├── decorators/
│   │   ├── current-user.decorator.ts     # @CurrentUser() parameter decorator
│   │   ├── roles.decorator.ts            # @Roles('admin', 'farmer')
│   │   └── public.decorator.ts           # @Public() skip auth
│   ├── filters/
│   │   └── all-exceptions.filter.ts      # Global exception formatting
│   ├── guards/
│   │   ├── jwt-auth.guard.ts             # JWT validation
│   │   └── roles.guard.ts                # Role-based access
│   ├── interceptors/
│   │   ├── logging.interceptor.ts        # Request/response logging
│   │   └── transform.interceptor.ts      # Response envelope (data, meta)
│   ├── pipes/
│   │   └── validation.pipe.ts            # Class-validator global pipe
│   ├── dto/
│   │   ├── pagination.dto.ts             # PaginationDto (page/limit/cursor)
│   │   └── api-response.dto.ts           # ApiResponse<T>, PaginatedResponseDto
│   └── pagination/
│       ├── cursor.util.ts                # Opaque keyset cursor encode/decode
│       └── keyset-paginator.ts           # paginate() — cursor + offset modes
│
├── config/
│   ├── app.config.ts                     # App configuration (env-based)
│   ├── database.config.ts                # TypeORM data source config
│   ├── stellar.config.ts                 # Stellar network + accounts
│   ├── oracle.config.ts                  # Oracle node settings
│   ├── jwt.config.ts                     # JWT secrets and expiry
│   └── queue.config.ts                   # Bull queue configuration
│
├── modules/
│   ├── auth/
│   │   ├── auth.module.ts
│   │   ├── auth.controller.ts
│   │   ├── auth.service.ts
│   │   ├── strategies/
│   │   │   ├── jwt.strategy.ts           # JWT verification
│   │   │   └── stellar-wallet.strategy.ts # Stellar signed-challenge auth
│   │   └── dto/
│   │       ├── challenge.dto.ts
│   │       ├── login.dto.ts
│   │       └── register.dto.ts
│   │
│   ├── users/
│   │   ├── users.module.ts
│   │   ├── users.controller.ts
│   │   ├── users.service.ts
│   │   ├── entities/
│   │   │   └── user.entity.ts
│   │   └── dto/
│   │       ├── create-user.dto.ts
│   │       └── update-user.dto.ts
│   │
│   ├── projects/
│   │   ├── projects.module.ts
│   │   ├── projects.controller.ts
│   │   ├── projects.service.ts
│   │   ├── entities/
│   │   │   ├── project.entity.ts
│   │   │   └── project-document.entity.ts
│   │   └── dto/
│   │       ├── create-project.dto.ts
│   │       ├── update-project.dto.ts
│   │       └── project-filter.dto.ts
│   │
│   ├── sensors/
│   │   ├── sensors.module.ts
│   │   ├── sensors.controller.ts
│   │   ├── sensors.service.ts
│   │   ├── sensors.gateway.ts            # WebSocket gateway
│   │   ├── entities/
│   │   │   ├── sensor-reading.entity.ts
│   │   │   └── sensor-device.entity.ts
│   │   └── dto/
│   │       ├── submit-reading.dto.ts
│   │       └── sensor-query.dto.ts
│   │
│   ├── credits/
│   │   ├── credits.module.ts
│   │   ├── credits.controller.ts
│   │   ├── credits.service.ts
│   │   ├── entities/
│   │   │   ├── credit-token.entity.ts
│   │   │   └── retirement.entity.ts
│   │   └── dto/
│   │       ├── retire-credits.dto.ts
│   │       └── credit-query.dto.ts
│   │
│   ├── oracle/
│   │   ├── oracle.module.ts
│   │   ├── oracle.controller.ts
│   │   ├── oracle.service.ts
│   │   ├── oracle.processor.ts           # Bull queue processor
│   │   ├── entities/
│   │   │   └── oracle-submission.entity.ts
│   │   └── dto/
│   │       └── submit-reading.dto.ts
│   │
│   ├── governance/
│   │   ├── governance.module.ts
│   │   ├── governance.controller.ts
│   │   ├── governance.service.ts
│   │   ├── entities/
│   │   │   └── proposal.entity.ts
│   │   └── dto/
│   │       ├── create-proposal.dto.ts
│   │       └── vote.dto.ts
│   │
│   ├── analytics/
│   │   ├── analytics.module.ts
│   │   ├── analytics.controller.ts
│   │   └── analytics.service.ts
│   │
│   └── notifications/
│       ├── notifications.module.ts
│       ├── notifications.service.ts
│       └── notifications.gateway.ts
│
├── stellar/
│   ├── stellar.module.ts
│   ├── stellar.service.ts               # High-level contract interactions
│   ├── stellar.client.ts                 # Low-level Soroban RPC wrapper
│   ├── stellar.types.ts                  # Contract ID type definitions
│   └── interfaces/
│       ├── credit-token.interface.ts     # Typed ABI for credit_token
│       ├── factory.interface.ts          # Typed ABI for credit_factory
│       ├── oracle.interface.ts           # Typed ABI for verification_oracle
│       └── retirement.interface.ts       # Typed ABI for retirement_registry
│
├── database/
│   ├── database.module.ts
│   ├── typeorm.config.ts
│   ├── entities/                         # Re-export barrel
│   └── migrations/
│       ├── 001_create_users.sql
│       ├── 002_create_projects.sql
│       ├── 003_create_sensor_readings.sql
│       ├── 004_create_retirements.sql
│       └── 005_create_oracle_submissions.sql
│
└── scripts/
    ├── seed.ts                           # Demo data seeder
    ├── deploy-contracts.ts               # Deploy Soroban contracts from backend
    └── simulate-sensors.ts               # Generate fake sensor data for testing
```

---

## 📦 Module Reference

### 1. Auth Module

Handles user authentication using Stellar wallets — no passwords required.

#### Authentication Flow

```
User                              Backend                         Stellar Network
 │                                  │                                  │
 │  POST /auth/challenge            │                                  │
 │  { wallet: "GABC...DEF" }       │                                  │
 │ ──────────────────────────────▶ │                                  │
 │                                  │  Generate random challenge       │
 │                                  │  Store in cache (5 min TTL)      │
 │  ◀────────────────────────────── │                                  │
 │  { challenge: "Sign this: ..." } │                                  │
 │                                  │                                  │
 │  User signs challenge with       │                                  │
 │  Freighter wallet extension      │                                  │
 │                                  │                                  │
 │  POST /auth/login                 │                                  │
 │  { wallet, signature }           │                                  │
 │ ──────────────────────────────▶ │                                  │
 │                                  │  Verify signature via            │
 │                                  │  Stellar SDK                     │
 │                                  │ ────────────────────────────────▶│
 │                                  │ ◀────────────────────────────────│
 │                                  │  { verified: true }              │
 │                                  │                                  │
 │                                  │  Issue JWT                       │
 │  ◀────────────────────────────── │                                  │
 │  { token, user, expiresIn }     │                                  │
 │                                  │                                  │
```

#### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/auth/challenge` | Public | Request a Stellar challenge message |
| `POST` | `/auth/login` | Public | Verify signed challenge, return JWT |
| `POST` | `/auth/register` | Public | Create user account (newcomers without wallet) |
| `POST` | `/auth/refresh` | Bearer | Refresh JWT before expiry |
| `POST` | `/auth/logout` | Bearer | Invalidate current session |

#### JWT Structure

```typescript
interface JwtPayload {
  sub: string;           // User UUID
  wallet: string;        // Stellar public key
  role: UserRole;        // "admin" | "developer" | "farmer" | "buyer" | "oracle"
  iat: number;
  exp: number;
}
```

---

### 2. Users Module

User profile and role management.

#### Endpoints

| Method | Path | Auth | Role | Description |
|---|---|---|---|---|
| `GET` | `/users/me` | Bearer | Any | Current user profile |
| `PATCH` | `/users/me` | Bearer | Any | Update profile (name, avatar, settings) |
| `GET` | `/users` | Bearer | Admin | List all users (paginated) |
| `GET` | `/users/:id` | Bearer | Admin | Get user by ID |
| `PATCH` | `/users/:id/role` | Bearer | Admin | Change user role |
| `PATCH` | `/users/:id/kyc` | Bearer | Admin | Update KYC status |
| `DELETE` | `/users/:id` | Bearer | Admin | Soft-delete user |

#### User Entity

```typescript
// entities/user.entity.ts
@Entity('users')
export class User {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ unique: true })
  wallet: string;                        // Stellar public key (G...)

  @Column({ nullable: true })
  email: string;

  @Column({ nullable: true })
  displayName: string;

  @Column({
    type: 'enum',
    enum: ['admin', 'developer', 'farmer', 'buyer', 'oracle'],
    default: 'buyer',
  })
  role: UserRole;

  @Column({ default: false })
  isKycVerified: boolean;

  @Column({ default: true })
  isActive: boolean;

  @CreateDateColumn()
  createdAt: Date;

  @UpdateDateColumn()
  updatedAt: Date;

  @OneToMany(() => Project, (project) => project.owner)
  projects: Project[];

  @OneToMany(() => Retirement, (retirement) => retirement.retiree)
  retirements: Retirement[];
}
```

---

### 3. Projects Module

Manage watershed restoration projects from registration through completion.

#### Endpoints

| Method | Path | Auth | Role | Description |
|---|---|---|---|---|
| `GET` | `/projects` | Bearer | Any | List projects (filterable) |
| `GET` | `/projects/:id` | Bearer | Any | Project detail with sensor stats |
| `POST` | `/projects` | Bearer | Developer, Admin | Create new project |
| `PATCH` | `/projects/:id` | Bearer | Developer, Admin | Update project metadata |
| `DELETE` | `/projects/:id` | Bearer | Admin | Soft-delete project |
| `POST` | `/projects/:id/submit` | Bearer | Developer | Submit for verification |
| `GET` | `/projects/:id/documents` | Bearer | Any | List project documents |
| `POST` | `/projects/:id/documents` | Bearer | Developer | Upload document |
| `GET` | `/projects/:id/credits` | Bearer | Any | Credit summary for project |
| `GET` | `/projects/:id/sensors` | Bearer | Any | Sensor devices for project |

#### Project Status Flow

```
DRAFT ──▶ REGISTERED ──▶ BASELINE ──▶ ACTIVE ──▶ COMPLETED ──▶ CLOSED
                │            │            │            │
                │            ▼            ▼            ▼
                │       Collecting    Credits     All credits
                │       baseline      being       retired or
                │       data (30d)    minted      expired
                ▼
            REJECTED
```

#### Query Parameters for `GET /projects`

| Parameter | Type | Example | Description |
|---|---|---|---|
| `status` | string | `active` | Filter by status |
| `methodology` | string | `Wetland_Restoration_v2` | Filter by methodology |
| `owner` | string | `GABC...` | Filter by owner wallet |
| `lat` | number | `38.8977` | Center latitude (for radius search) |
| `lon` | number | `-77.0365` | Center longitude |
| `radius` | number | `50` | Search radius in km |
| `search` | string | `Green Valley` | Text search in name/description |
| `page` | number | `1` | Page number |
| `limit` | number | `20` | Items per page |
| `sort` | string | `createdAt:desc` | Sort field and direction |

---

### 4. Sensors Module

Ingest, validate, and serve real-time sensor data from IoT devices deployed at project sites.

#### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `POST` | `/sensors/reading` | API Key | Submit a sensor reading (sensor → backend) |
| `GET` | `/sensors/devices` | Bearer | List sensor devices for current user |
| `POST` | `/sensors/devices` | Bearer | Register a new sensor device |
| `GET` | `/sensors/devices/:id` | Bearer | Get device details |
| `GET` | `/sensors/projects/:projectId/readings` | Bearer | Reading history for a project |
| `GET` | `/sensors/projects/:projectId/latest` | Bearer | Most recent reading |
| `GET` | `/sensors/projects/:projectId/summary` | Bearer | Aggregated stats (daily/weekly/monthly) |
| `WS` | `/sensors/live` | Bearer (query) | Real-time sensor feed |

#### Sensor Reading Payload

```json
{
  "deviceId": "sensor-gv-001",
  "projectId": "proj_abc123",
  "timestamp": 1700000000,
  "readings": {
    "ph": 7.2,
    "turbidity_ntu": 12.4,
    "dissolved_oxygen_mgl": 6.8,
    "flow_rate_cms": 1.834,
    "total_nitrogen_mgl": 2.45,
    "total_phosphorus_mgl": 0.125,
    "temperature_c": 18.5
  },
  "signature": "0xabc123def456..."
}
```

#### Sensor Device Registration

```json
{
  "deviceId": "sensor-gv-001",
  "projectId": "proj_abc123",
  "manufacturer": "YSI",
  "model": "ProDSS",
  "location": {
    "lat": 38.8977,
    "lon": -77.0365
  },
  "parameters": ["ph", "turbidity", "do", "temp"],
  "publicKey": "0x04a1b2..."   // ECDSA public key for signature verification
}
```

#### WebSocket Gateway

The `SensorsGateway` uses Socket.IO to broadcast real-time sensor readings to subscribed clients.

**Client connection:**

```typescript
import { io } from 'socket.io-client';

const socket = io('wss://api.water-credits.io', {
  auth: { token: 'Bearer <JWT>' },
});

// Subscribe to a specific project
socket.emit('subscribe:project', { projectId: 'proj_abc123' });

// Listen for new readings
socket.on('sensor:reading', (data) => {
  console.log('New reading:', data);
});

// Listen for alerts
socket.on('sensor:alert', (data) => {
  console.warn('Threshold breach:', data);
});

// Unsubscribe
socket.emit('unsubscribe:project', { projectId: 'proj_abc123' });
```

---

### 5. Credits Module

Query credit balances, initiate retirements, and generate certificates.

#### Endpoints

| Method | Path | Auth | Role | Description |
|---|---|---|---|---|
| `GET` | `/credits` | Bearer | Any | Global credit overview |
| `GET` | `/credits/projects/:projectId` | Bearer | Any | Credit detail for a project |
| `GET` | `/credits/portfolio` | Bearer | Any | Current user's credit holdings |
| `POST` | `/credits/retire` | Bearer | Any | Initiate credit retirement |
| `GET` | `/credits/retirements` | Bearer | Any | Retirement history |
| `GET` | `/credits/retirements/:id` | Bearer | Any | Retirement detail |
| `GET` | `/credits/retirements/:id/certificate` | Bearer | Any | Download certificate PDF |

#### Retirement Request

```json
{
  "projectId": "proj_abc123",
  "amount": 50000,
  "purpose": "compliance",
  "metadataUri": "ipfs://QmXK...",
  "notes": "FY2025 EPA compliance retirement"
}
```

#### Retirement Response

```json
{
  "id": "ret_001",
  "status": "confirmed",
  "txHash": "a1b2c3d4e5f6...",
  "blockNumber": 12345678,
  "certificate": {
    "id": "WQC-2025-001-0042",
    "url": "https://api.water-credits.io/credits/retirements/ret_001/certificate",
    "ipfsUri": "ipfs://QmCert..."
  },
  "timestamp": 1700000000
}
```

---

### 6. Oracle Module

Manages the off-chain oracle node infrastructure that submits sensor data to Soroban.

#### Endpoints

| Method | Path | Auth | Role | Description |
|---|---|---|---|---|
| `GET` | `/oracle/status` | Bearer | Oracle, Admin | Oracle node health |
| `GET` | `/oracle/submissions` | Bearer | Oracle, Admin | Submission history |
| `GET` | `/oracle/submissions/:id` | Bearer | Oracle, Admin | Submission detail |
| `GET` | `/oracle/pending` | Bearer | Oracle, Admin | Pending readings waiting for submission |
| `POST` | `/oracle/trigger` | Bearer | Oracle, Admin | Manually trigger submission cycle |
| `GET` | `/oracle/contract-config` | Bearer | Oracle, Admin | Current on-chain oracle config |

#### Oracle Submission Pipeline

```
1. Sensor readings arrive → stored in PostgreSQL sensor_readings table
2. Cron job runs every hour → collects readings from last hour
3. Aggregates into time-window buckets (median per parameter)
4. Validates against physical thresholds
5. Calls verification_oracle.submit_reading() on Soroban
6. Stores submission result in oracle_submissions table
7. Updates sensor_reading batch status
8. Emits WebSocket event on completion
```

#### Scheduled Submission Cycle

`OracleSchedulerService` (`src/modules/oracle/oracle-scheduler.service.ts`) drives
step 2. It runs on `@Cron` under the name `oracle-submission-cycle`, and each
tick:

1. Loads every project in `ACTIVE` status.
2. For each project — **sequentially**, because the oracle nonce is
   per-`(project_id, oracle_address)` — selects its `PENDING` reading batches
   that have `reading_count > 0` and whose 15-minute collection window has
   already closed (`created_at < NOW() - 15min`). Batches still inside the
   window are left alone so a partial window is never submitted.
3. Claims each batch with a conditional `UPDATE … WHERE status = 'pending'`.
   Only the caller that flips `pending → submitted` proceeds, so an overlapping
   tick, a second replica, or a concurrent `POST /oracle/trigger` cannot submit
   the same batch twice. A failed submission releases the claim for the next
   cycle.
4. Aggregates that batch's verified readings and calls
   `OracleService.triggerSubmission()`, which allocates the nonce under a
   PostgreSQL advisory lock and enqueues the `oracle-submit` job.
5. Records `last_scheduled_at` in `oracle_schedule_state` (one `global` row plus
   one row per project) so `GET /health` can report oracle freshness.

The cron is stopped in `onApplicationShutdown`, and an in-flight cycle stops
between batches, so a terminating pod does not fire spurious submissions while
it drains.

**Configuration** (see `.env.example`):

| Variable | Default | Purpose |
|---|---|---|
| `ORACLE_SUBMISSION_INTERVAL_CRON` | `0 * * * *` | Schedule expression. Accepts 5- or 6-field cron; testnet operators can use e.g. `*/5 * * * *`. A malformed value logs a warning and falls back to hourly. |
| `ORACLE_ADDRESS` | *(empty)* | Address the scheduler submits as. Empty disables the scheduled cycle; manual `POST /oracle/trigger` is unaffected since it carries its own address. |
| `ORACLE_SCHEDULER_ENABLED` | `true` | Set to `false` to keep the cron registered but inert. |
| `ORACLE_STALENESS_THRESHOLD_S` | `7200` | Seconds without a completed cycle before `GET /health` marks the oracle `degraded`. |

`GET /health` reports the result under `checks.oracle`:

```json
{
  "checks": {
    "oracle": {
      "status": "ok",
      "enabled": true,
      "cron": "0 * * * *",
      "last_scheduled_at": "2026-08-18T09:00:00.000Z",
      "staleness_s": 42,
      "last_submission_count": 3
    }
  }
}
```

#### Oracle Queue (Bull)

```typescript
// oracle.processor.ts
@Processor('oracle-submission')
export class OracleProcessor {
  @Process('submit-batch')
  async handleBatchSubmission(job: Job<BatchJob>) {
    const { projectId, readings, nonce } = job.data;

    // Build Soroban transaction
    const tx = await this.stellarService.buildOracleSubmission(
      projectId,
      readings,
      nonce,
    );

    // Sign and submit
    const result = await this.stellarService.submitTransaction(tx);

    // Store result
    await this.oracleService.recordSubmission(projectId, result);

    // Update nonce
    await this.oracleService.incrementNonce(projectId);
  }
}
```

---

### 7. Governance Module

Interface for on-chain governance — proposals, voting, and protocol configuration.

#### Endpoints

| Method | Path | Auth | Role | Description |
|---|---|---|---|---|
| `GET` | `/governance/config` | Bearer | Any | Current protocol parameters |
| `POST` | `/governance/config` | Bearer | Admin | Update config (off-chain cache) |
| `GET` | `/governance/proposals` | Bearer | Any | List proposals |
| `POST` | `/governance/proposals` | Bearer | Any | Create proposal |
| `GET` | `/governance/proposals/:id` | Bearer | Any | Proposal detail |
| `POST` | `/governance/proposals/:id/vote` | Bearer | Any | Vote on proposal |
| `POST` | `/governance/proposals/:id/execute` | Bearer | Admin | Execute approved proposal |
| `GET` | `/governance/multisig` | Bearer | Admin | List multisig members |
| `POST` | `/governance/multisig` | Bearer | Admin | Add/remove multisig member |

---

### 8. Analytics Module

Aggregated data for the frontend dashboard widgets.

#### Endpoints

| Method | Path | Auth | Description |
|---|---|---|---|
| `GET` | `/analytics/overview` | Bearer | Total projects, credits minted, retired, active users |
| `GET` | `/analytics/credits-over-time` | Bearer | Monthly mint/retire volumes |
| `GET` | `/analytics/project-distribution` | Bearer | Projects by methodology, status, geography |
| `GET` | `/analytics/retirement-by-purpose` | Bearer | Compliance vs. voluntary breakdown |
| `GET` | `/analytics/top-projects` | Bearer | Highest credit-generating projects |
| `GET` | `/analytics/top-retirees` | Bearer | Most active credit buyers |

---

### 9. Notifications Module

In-app and email notifications for important events.

#### Notification Types

| Event | Channel | Message |
|---|---|---|
| Credit minted | In-app | "500 credits minted for Green Valley Wetland" |
| Credit retired | In-app | "Your retirement of 1,000 credits is confirmed" |
| Sensor alert | In-app + Email | "⚠️ pH reading out of range at Green Valley" |
| Project status change | In-app | "Green Valley Wetland is now ACTIVE" |
| Oracle missed submission | Email | "Oracle node missed 3 consecutive submissions" |
| Proposal created | In-app | "New governance proposal: Update oracle fees" |
| Proposal passed | In-app | "Proposal #42 passed! Changes will take effect in 7 days" |

---

## 🗄️ Database Schema

### Entity Relationship Diagram

```
┌─────────────────┐       ┌─────────────────────┐       ┌────────────────────┐
│      users       │       │      projects        │       │  sensor_devices    │
├─────────────────┤       ├─────────────────────┤       ├────────────────────┤
│ id (PK, UUID)   │───1:N─│ id (PK, UUID)        │───1:N─│ id (PK, UUID)      │
│ wallet (unique)  │       │ owner_id (FK)        │       │ project_id (FK)    │
│ email            │       │ name                 │       │ device_id (unique) │
│ display_name     │       │ description          │       │ manufacturer       │
│ role (enum)      │       │ latitude             │       │ model              │
│ is_kyc_verified  │       │ longitude            │       │ parameters (jsonb) │
│ is_active        │       │ methodology          │       │ public_key         │
│ created_at       │       │ status (enum)        │       │ last_reading_at    │
│ updated_at       │       │ area_hectares        │       │ created_at         │
└─────────────────┘       │ credit_token_address  │       └────────────────────┘
                          │ contract_id           │                │
                          │ baseline_started_at   │                │
                          │ baseline_ended_at     │                │ 1:N
                          │ created_at            │                │
                          │ updated_at            │                ▼
                          └─────────────────────┘       ┌────────────────────┐
                                  │                      │  sensor_readings    │
                                  │ 1:N                  ├────────────────────┤
                                  │                      │ id (PK, UUID)      │
                                  ▼                      │ device_id (FK)     │
┌─────────────────────┐                                  │ project_id (FK)    │
│ project_documents    │                                  │ timestamp           │
├─────────────────────┤                                  │ ph (numeric)        │
│ id (PK, UUID)        │                                  │ turbidity_ntu       │
│ project_id (FK)      │                                  │ dissolved_oxygen    │
│ document_type (enum) │                                  │ flow_rate_cms       │
│ filename             │                                  │ total_nitrogen      │
│ ipfs_uri             │                                  │ total_phosphorus    │
│ uploaded_at          │                                  │ temperature_c       │
└─────────────────────┘                                  │ signature (text)    │
                                                          │ is_verified (bool)  │
┌─────────────────────┐       ┌─────────────────────┐    │ batch_id (FK)       │
│  retirements         │       │  oracle_submissions  │    │ created_at           │
├─────────────────────┤       ├─────────────────────┤    └────────────────────┘
│ id (PK, UUID)        │       │ id (PK, UUID)        │             │
│ user_id (FK)         │       │ project_id (FK)      │             │
│ project_id (FK)      │       │ oracle_address       │             │ 1:N
│ amount (numeric)     │       │ nonce                │             │
│ purpose (string)     │       │ tx_hash              │             ▼
│ metadata_uri         │       │ status (enum)        │    ┌────────────────────┐
│ tx_hash              │       │ readings_snapshot    │    │ reading_batches     │
│ certificate_ipfs_uri │       │ result (jsonb)       │    ├────────────────────┤
│ retired_at           │       │ submitted_at         │    │ id (PK, UUID)      │
│ created_at           │       │ confirmed_at         │    │ project_id (FK)     │
└─────────────────────┘       └─────────────────────┘    │ status (enum)       │
                                                          │ reading_count        │
┌─────────────────────┐       ┌─────────────────────┐    │ credits_generated    │
│  proposals           │       │ governance_config    │    │ submitted_at         │
├─────────────────────┤       ├─────────────────────┤    │ confirmed_at         │
│ id (PK, UUID)        │       │ id (PK, UUID)        │    └────────────────────┘
│ proposer_id (FK)     │       │ protocol_fee_bps     │
│ title                │       │ min_oracles          │
│ description          │       │ ph_min / ph_max       │
│ action_type          │       │ do_threshold          │
│ action_params (jsonb)│       │ temp_penalty_delta    │
│ votes_for            │       │ weight_volumetric     │
│ votes_against        │       │ weight_nitrogen       │
│ status (enum)        │       │ weight_phosphorus     │
│ deadline             │       │ updated_by            │
│ executed_at          │       │ updated_at            │
│ created_at           │       └─────────────────────┘
└─────────────────────┘
```

---

## 📡 API Reference

### Response Envelope

All API responses follow a consistent envelope:

```typescript
// Success
{
  "success": true,
  "data": { ... },
  "meta": { ... },          // present on list endpoints (see Pagination)
  "timestamp": "2026-08-22T10:00:00.000Z"
}

// Error
{
  "success": false,
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid input data",
    "details": [
      { "field": "amount", "message": "must be a positive integer" }
    ]
  }
}
```

### Pagination

List endpoints support **two pagination modes** on the same route. The `meta.mode`
field tells clients which one produced the page.

| Mode | Query params | `meta` fields | When to use |
|---|---|---|---|
| **Cursor** (keyset) | `?cursor=<opaque>&limit=` | `mode`, `limit`, `count`, `nextCursor`, `hasMore` | **Preferred.** Stable under concurrent writes, O(limit) at any depth. |
| **Offset** (legacy) | `?page=&limit=` | `mode`, `limit`, `total`, `page`, `totalPages` | Backwards-compatible; needs a total count. Can duplicate/skip rows under concurrent inserts. |

If `cursor` is supplied it takes precedence over `page`. `limit` defaults to 20 (max 100).

**Cursor (keyset) pagination** seeks past an opaque `(sortValue, id)` cursor instead
of counting from the top with `OFFSET`. Because the sort column (`created_at`,
`timestamp`, `retired_at`) is paired with the immutable `id` as a tiebreaker, paging
is a strict total order that neither duplicates nor skips rows when new rows are
inserted mid-pagination — the failure mode `OFFSET` exhibits on this platform's
high-volume tables (sensor readings, oracle submissions, retirements).

```jsonc
// GET /sensors/readings?limit=2   → first page
{
  "success": true,
  "data": [ /* 2 readings, newest first */ ],
  "meta": {
    "mode": "cursor",
    "limit": 2,
    "count": 2,
    "nextCursor": "eyJ2IjoiMjAyNi0wOC0yMlQxMDowMDowMC4wMDBaIiwiaWQiOiIuLi4ifQ",
    "hasMore": true
  },
  "timestamp": "2026-08-22T10:00:00.000Z"
}

// GET /sensors/readings?cursor=eyJ2Ijoi...&limit=2   → next page
// Walk until meta.hasMore === false (meta.nextCursor is then null).
```

Treat `nextCursor` as **opaque** — do not construct or mutate it. A malformed or
tampered cursor returns `400 Bad Request`.

Cursor pagination is available on: `GET /sensors/readings`, `GET /oracle/submissions`,
`GET /credits/retirements`, `GET /governance/proposals`, `GET /notifications`, and
`GET /users`. Each is backed by a composite `(filter?, sortColumn, id)` index
(migration `018_add_keyset_pagination_indexes.sql`) so the seek resolves as an
index range scan.

### Rate Limiting

| Endpoint Group | Rate Limit | Burst |
|---|---|---|
| Public (challenge, register) | 10/min | 20 |
| Authenticated (general) | 60/min | 120 |
| Sensor ingestion | 1000/min | 2000 |
| Oracle submissions | 30/min | 60 |
| Admin endpoints | 20/min | 40 |

### Status Codes

| Code | Meaning |
|---|---|
| `200` | Success |
| `201` | Created |
| `400` | Bad request (validation error) |
| `401` | Unauthorized (missing/invalid JWT) |
| `403` | Forbidden (wrong role) |
| `404` | Not found |
| `409` | Conflict (duplicate) |
| `422` | Unprocessable (business logic error) |
| `429` | Too many requests |
| `500` | Internal server error |

---

## ⚡ Queue Architecture

### Bull Queue Overview

```
                      ┌─────────────────┐
                      │    Redis         │
                      │  (Bull backend)  │
                      └────────┬────────┘
                               │
              ┌────────────────┼────────────────┐
              ▼                ▼                ▼
    ┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
    │ sensor-ingestion │ │ oracle-submit   │ │ retirements     │
    │                  │ │                 │ │                 │
    │ Ingest raw       │ │ Aggregate and   │ │ Sign and submit │
    │ readings from    │ │ submit verified │ │ retirement      │
    │ sensors          │ │ readings to     │ │ transactions to │
    │ Validate and     │ │ Soroban         │ │ Soroban         │
    │ store            │ │                 │ │ Generate certs  │
    └─────────────────┘ └─────────────────┘ └─────────────────┘
```

### Queue Definitions

#### `sensor-ingestion`

| Property | Value |
|---|---|
| Concurrency | 5 |
| Retry attempts | 3 |
| Backoff | Exponential (1s, 5s, 30s) |
| TTL | 1 hour |

**Job data:**
```typescript
interface SensorIngestionJob {
  deviceId: string;
  projectId: string;
  readings: SensorReadingDto;
  receivedAt: number; // Unix timestamp
}
```

#### `oracle-submit`

| Property | Value |
|---|---|
| Concurrency | 1 (nonce ordering) |
| Retry attempts | 5 |
| Backoff | Exponential (10s, 60s, 300s) |
| Repeat | Cron: `0 * * * *` (every hour) |
| TTL | 24 hours |

**Job data:**
```typescript
interface OracleSubmissionJob {
  batchId: string;
  projectId: string;
  aggregatedReadings: AggregatedReading;
  nonce: number;
}
```

#### `retirements`

| Property | Value |
|---|---|
| Concurrency | 2 |
| Retry attempts | 3 |
| Backoff | Fixed (30s) |
| TTL | 6 hours |

**Job data:**
```typescript
interface RetirementJob {
  retirementId: string;
  userId: string;
  projectId: string;
  amount: number;
  purpose: string;
  metadataUri: string;
}
```

---

## ⭐ Stellar Integration

### `StellarService`

The `stellar.service.ts` is the core integration point with the Stellar network.

```typescript
@Injectable()
export class StellarService {
  constructor(
    private readonly config: ConfigService,
    private readonly stellarClient: StellarClient,
  ) {}

  // ── Authentication ──
  async generateChallenge(wallet: string): Promise<string>;
  async verifySignature(wallet: string, signature: string, challenge: string): Promise<boolean>;

  // ── Contract Interactions ──
  async getCreditBalance(tokenId: string, address: string): Promise<BigNumber>;
  async getTotalSupply(tokenId: string): Promise<BigNumber>;
  async getTotalRetired(tokenId: string): Promise<BigNumber>;

  async mintCredits(tokenId: string, to: string, amount: BigNumber): Promise<TransactionResult>;
  async retireCredits(tokenId: string, holder: string, amount: BigNumber, purpose: string, metadataUri: string): Promise<RetirementResult>;

  async submitOracleReading(contractId: string, projectId: string, reading: SensorReading, nonce: number): Promise<TransactionResult>;

  async getProtocolConfig(): Promise<GovernanceConfig>;
  async createProposal(proposer: string, description: string, action: string, params: string[]): Promise<string>;
  async voteOnProposal(voter: string, proposalId: string, support: boolean): Promise<void>;

  // ── Network ──
  async getAccount(address: string): Promise<Account>;
  async getNetwork(): Promise<{ passphrase: string; rpcUrl: string }>;
  async estimateFee(tx: Transaction): Promise<BigNumber>;
  async submitTransaction(tx: Transaction): Promise<TransactionResult>;

  // ── Events ──
  async getEvents(filter: EventFilter): Promise<SorobanEvent[]>;
  async streamEvents(filter: EventFilter, callback: (event: SorobanEvent) => void): Promise<void>;
}
```

### `StellarClient`

Low-level wrapper around `@stellar/stellar-sdk`:

```typescript
@Injectable()
export class StellarClient {
  private server: SorobanServer;
  private keypair: Keypair;

  constructor(config: StellarConfig) {
    this.server = new SorobanServer(config.rpcUrl);
    this.keypair = Keypair.fromSecret(config.backendSecret);
  }

  async getContractData(contractId: string, key: ScVal): Promise<ScVal>;
  async simulateTx(tx: Transaction): Promise<SimulateResult>;
  async prepareTx(tx: Transaction): Promise<Transaction>;
  async sendTx(tx: Transaction): Promise<TransactionResult>;
  async getLedgerEntries(keys: LedgerKey[]): Promise<LedgerEntry[]>;
}
```

---

## 🔌 WebSocket Events

### Server → Client Events

| Event | Payload | When |
|---|---|---|
| `sensor:reading` | `{ projectId, deviceId, parameter, value, unit, timestamp }` | New sensor reading received |
| `sensor:alert` | `{ projectId, deviceId, parameter, value, threshold, direction }` | Parameter outside acceptable range |
| `sensor:device-status` | `{ deviceId, status, lastSeen }` | Device online/offline |
| `credit:minted` | `{ projectId, amount, beneficiary, txHash }` | Credits minted on chain |
| `credit:retired` | `{ projectId, amount, retiree, purpose, txHash }` | Credits retired on chain |
| `credit:transferred` | `{ from, to, amount, projectId }` | Credits transferred between wallets |
| `oracle:status` | `{ oracleId, status, lastSubmission, missedCount }` | Oracle node health change |
| `oracle:submitted` | `{ projectId, nonce, creditsGenerated, txHash }` | Oracle submission confirmed |
| `governance:proposal` | `{ proposalId, title, status, deadline }` | Proposal created/updated |
| `governance:vote` | `{ proposalId, voter, support }` | New vote cast |
| `notification` | `{ id, type, title, message, actionUrl }` | User notification |

### Client → Server Events

| Event | Payload | Description |
|---|---|---|
| `subscribe:project` | `{ projectId }` | Subscribe to all events for a project |
| `unsubscribe:project` | `{ projectId }` | Unsubscribe from project events |
| `subscribe:user` | `{ userId }` | Subscribe to user-specific notifications |
| `unsubscribe:user` | `{ userId }` | Unsubscribe from user notifications |
| `subscribe:admin` | `{}` | Subscribe to admin events (admin only) |

---

## 🔐 Authentication Flow

### Stellar Wallet Authentication (Primary)

```
1. Client: POST /auth/challenge { wallet: "GABC...DEF" }
2. Server: Generate random challenge string
           Store in Redis with 5-min TTL
           Return { challenge: "Sign this message to authenticate..." }
3. Client: User signs challenge with Freighter wallet
4. Client: POST /auth/login { wallet, signature }
5. Server: Verify signature using Stellar SDK
           - Recover public key from signature
           - Check recovered key === wallet
           - Delete challenge from Redis (one-time use)
6. Server: Find or create User by wallet address
           Generate JWT with { sub, wallet, role, iat, exp }
7. Server: Return { token, user, expiresIn }
```

### JWT-Based Authorization (Subsequent)

```
1. Client: Attach Authorization: Bearer <JWT> to all requests
2. Server: JwtAuthGuard extracts and validates JWT
3. Server: JwtStrategy.validate() loads user from DB
4. Server: Attach User to request object
5. Server: RolesGuard checks user.role against required roles
```

### API Key Authentication (Sensors)

Sensor devices authenticate via pre-shared API keys:

```
Header: X-API-Key: wc_sensor_abc123def456
```

API keys are stored hashed (bcrypt) in the database, associated with a device.

---

## 🔧 Environment Configuration

### All Variables

```bash
# ── Application ──
NODE_ENV=development                      # development | production | test
PORT=3000                                 # API server port
API_PREFIX=/api/v1                        # Global API prefix
CORS_ORIGIN=http://localhost:4200         # Frontend origin

# ── Database (PostgreSQL) ──
DATABASE_HOST=localhost
DATABASE_PORT=5432
DATABASE_NAME=water_credits
DATABASE_USER=postgres
DATABASE_PASSWORD=postgres
DATABASE_SSL=false                        # Enable in production
DATABASE_LOGGING=false                    # Enable for debugging

# ── Redis (Bull Queues + Cache) ──
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_PASSWORD=

# WebSocket Redis adapter
# Startup wait before SensorsGateway keeps the in-process adapter (milliseconds)
WS_REDIS_CONNECT_TIMEOUT_MS=5000

# ── Stellar Network ──
STELLAR_NETWORK=testnet                   # testnet | public
STELLAR_RPC_URL=https://soroban-testnet.stellar.org
STELLAR_NETWORK_PASSPHRASE="Test SDF Network ; September 2015"

# ── Stellar Backend Account ──
# Required for on-chain writes (oracle submit, retire, governance).
# Empty / placeholder (SDN...TODO) / invalid → GET /health reports
# checks.stellar.signing_ready=false and status=degraded.
STELLAR_BACKEND_SECRET=SXXX...YYY        # Backend Stellar account secret (S…)
STELLAR_BACKEND_PUBLIC=GABC...DEF        # Backend Stellar account public (G…)
# Fail boot if the backend secret is missing/placeholder/invalid.
# Set true in production. Default false so local/dev can still start.
STELLAR_REQUIRE_SIGNING_KEY=false

# ── Contract Addresses (deployed on Stellar) ──
CONTRACT_CREDIT_FACTORY=C...
CONTRACT_VERIFICATION_ORACLE=C...
CONTRACT_RETIREMENT_REGISTRY=C...
CONTRACT_GOVERNANCE=C...

# ── JWT ──
JWT_SECRET=<random-64-byte-hex-string>
JWT_EXPIRATION=1h                        # Access token TTL
JWT_REFRESH_EXPIRATION=7d                # Refresh token TTL

# ── Oracle ──
ORACLE_ADDRESS=G...                      # Oracle Stellar wallet
ORACLE_SECRET=S...                       # Oracle Stellar secret
ORACLE_SUBMISSION_INTERVAL=3600000       # ms (default: 1 hour)
ORACLE_MIN_CONFIRMATIONS=2               # Min oracle confirmations

# ── Queue ──
QUEUE_SENSOR_CONCURRENCY=5
QUEUE_ORACLE_CONCURRENCY=1
QUEUE_RETIREMENT_CONCURRENCY=2

# ── Rate Limiting ──
THROTTLE_TTL=60000                       # Window (ms)
THROTTLE_LIMIT=60                        # Max requests per window

# ── Logging ──
LOG_LEVEL=debug                          # error | warn | info | debug
LOG_FORMAT=json                          # json | text

# ── Monitoring ──
SENTRY_DSN=                              # Sentry DSN (optional)
PROMETHEUS_ENABLED=true                  # Enable /metrics endpoint

# ── External APIs ──
IPFS_API_URL=https://ipfs.infura.io:5001
IPFS_PROJECT_ID=
IPFS_PROJECT_SECRET=
```

---

## 🚢 Deployment Guide

### Docker

```dockerfile
# Dockerfile
FROM node:20-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci
COPY . .
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./
COPY --from=builder /app/.env ./
EXPOSE 3000
CMD ["node", "dist/main"]
```

```yaml
# docker-compose.yml
version: "3.8"
services:
  backend:
    build: .
    ports:
      - "3000:3000"
    depends_on:
      postgres:
        condition: service_healthy
      redis:
        condition: service_healthy
    environment:
      DATABASE_HOST: postgres
      REDIS_HOST: redis
    env_file: .env

  postgres:
    image: postgres:15-alpine
    volumes:
      - pgdata:/var/lib/postgresql/data
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U postgres"]
    environment:
      POSTGRES_DB: water_credits
      POSTGRES_USER: postgres
      POSTGRES_PASSWORD: postgres

  redis:
    image: redis:7-alpine
    healthcheck:
      test: ["CMD", "redis-cli", "ping"]

volumes:
  pgdata:
```

### Kubernetes (Production)

See `k8s/` directory for manifests:

- `deployment.yaml` — Backend deployment (3 replicas)
- `service.yaml` — ClusterIP service
- `ingress.yaml` — Ingress with TLS
- `hpa.yaml` — Horizontal pod autoscaler
- `configmap.yaml` — Non-sensitive config
- `secret.yaml` — Sensitive config (use SealedSecrets or External Secrets Operator)

### CI/CD (GitHub Actions)

```yaml
# .github/workflows/deploy.yml
name: Deploy
on:
  push:
    branches: [main]

jobs:
  test:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:15
        env:
          POSTGRES_DB: water_credits_test
          POSTGRES_USER: postgres
          POSTGRES_PASSWORD: postgres
        ports:
          - 5432:5432
      redis:
        image: redis:7
        ports:
          - 6379:6379
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run migration:run
      - run: npm test
      - run: npm run test:e2e

  deploy:
    needs: test
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - run: docker build -t water-credits-backend .
      - run: docker push ${{ secrets.REGISTRY }}/water-credits-backend
      - run: kubectl set image deployment/backend backend=${{ secrets.REGISTRY }}/water-credits-backend
```

---

## 🧪 Testing Strategy

### Test Pyramid

```
         ╱╲
        ╱ E2E ╲           ← 5% — Full system tests (Supertest)
       ╱───────╲
      ╱Integration╲        ← 25% — Module interaction tests
     ╱─────────────╲
    ╱   Unit Tests   ╲    ← 70% — Isolated service tests
   ╱───────────────────╲
```

### Running Tests

```bash
# Unit tests
npm test

# Watch mode
npm run test:watch

# With coverage
npm run test:cov

# E2E tests (requires postgres + redis)
npm run test:e2e
```

### Test Structure

```
src/
├── modules/
│   ├── auth/
│   │   ├── auth.controller.spec.ts
│   │   ├── auth.service.spec.ts
│   │   └── strategies/
│   │       ├── jwt.strategy.spec.ts
│   │       └── stellar-wallet.strategy.spec.ts
│   ├── projects/
│   │   ├── projects.controller.spec.ts
│   │   └── projects.service.spec.ts
│   ├── sensors/
│   │   ├── sensors.controller.spec.ts
│   │   └── sensors.service.spec.ts
│   └── credits/
│       ├── credits.controller.spec.ts
│       └── credits.service.spec.ts
├── stellar/
│   ├── stellar.service.spec.ts
│   └── stellar.client.spec.ts
└── common/
    ├── guards/
    │   ├── jwt-auth.guard.spec.ts
    │   └── roles.guard.spec.ts
    └── pipes/
        └── validation.pipe.spec.ts
```

---

## 📊 Monitoring & Observability

### Health Check

```bash
GET /health
```

```json
{
  "status": "ok",
  "timestamp": "2024-01-01T00:00:00.000Z",
  "uptime_s": 3600,
  "checks": {
    "database": { "status": "ok", "latency_ms": 2 },
    "redis": { "status": "ok", "latency_ms": 1 },
    "stellar": {
      "status": "ok",
      "latency_ms": 12,
      "signing_ready": true,
      "detail": "latest_ledger=12345678"
    },
    "queues": {
      "sensor-ingestion": { "status": "ok", "waiting": 0, "active": 2, "failed": 0 },
      "oracle-submit": { "status": "ok", "waiting": 1, "active": 0, "failed": 0 },
      "retirements": { "status": "ok", "waiting": 0, "active": 0, "failed": 0 }
    }
  }
}
```

If `STELLAR_BACKEND_SECRET` is missing or invalid, `checks.stellar.signing_ready` is `false` and both `checks.stellar.status` and top-level `status` become `degraded` (HTTP still 200). Set `STELLAR_REQUIRE_SIGNING_KEY=true` to refuse startup instead.

### Metrics (Prometheus)

Available at `GET /metrics`:

| Metric | Type | Labels | Description |
|---|---|---|---|
| `http_requests_total` | Counter | method, path, status | Total HTTP requests |
| `http_request_duration_ms` | Histogram | method, path | Request latency |
| `stellar_rpc_calls_total` | Counter | method, contract | Soroban RPC calls |
| `stellar_rpc_duration_ms` | Histogram | method | RPC latency |
| `sensor_readings_total` | Counter | project, status | Sensor readings received |
| `credits_minted_total` | Counter | project | Credits minted |
| `credits_retired_total` | Counter | project | Credits retired |
| `queue_depth` | Gauge | queue | Current queue depth |
| `queue_failed_total` | Counter | queue | Failed jobs |
| `oracle_submissions_total` | Counter | status | Oracle submissions |

### Logging (Winston)

```json
{
  "level": "info",
  "timestamp": "2025-06-04T12:00:00.000Z",
  "context": "StellarService",
  "message": "Credits minted successfully",
  "data": {
    "projectId": "proj_abc123",
    "amount": 5000,
    "txHash": "a1b2c3...",
    "duration_ms": 234
  }
}
```

---

## 🛡️ Security

| Area | Implementation |
|---|---|
| **Authentication** | Stellar wallet challenge-response + JWT |
| **Authorization** | Role-based guards (`@Roles('admin')`) |
| **Rate limiting** | @nestjs/throttler with per-endpoint configuration |
| **CORS** | Whitelist frontend origin only |
| **Helmet** | Security headers (CSP, HSTS, X-Frame-Options) |
| **Input validation** | class-validator DTOs on every endpoint |
| **SQL injection** | TypeORM parameterized queries |
| **Secrets** | Environment variables (never hardcoded) |
| **HTTPS** | TLS termination at ingress level |
| **CSRF** | SameSite cookies + custom header check |
| **Dependency audit** | `npm audit` in CI pipeline |
| **Container security** | Non-root user in Docker, read-only filesystem |
| **API keys** | Hashed (bcrypt) in database, rotated regularly |

---

## 🗺️ Roadmap

### Current Status — v0.1 (July 2026)

The core infrastructure is in place. The backend boots, all modules are scaffolded, migrations run, and the CI pipeline is green. The project is in **active early development** — not yet ready for production use.

| Area | Status |
|---|---|
| Project scaffolding & module structure | ✅ Done |
| Database migrations (users, projects, sensors, oracle, governance) | ✅ Done |
| Auth module (Stellar wallet challenge-response + JWT) | ✅ Done |
| Users module (CRUD, role management) | ✅ Done |
| Projects module (full lifecycle) | ✅ Done |
| Sensors module (ingestion, WebSocket gateway) | ✅ Done |
| Credits module (balance queries, retirement flow) | ✅ Done |
| Oracle module (Bull queue, Soroban submission) | ✅ Done |
| Governance module (proposals, voting) | ✅ Done |
| Analytics module | ✅ Done |
| Notifications module (in-app + email) | ✅ Done |
| Health check & Prometheus metrics | ✅ Done |
| Docker & docker-compose setup | ✅ Done |
| Unit & e2e test coverage | 🔄 In progress |
| Stellar Soroban contract integration (live testnet) | 🔄 In progress |
| IPFS document/certificate upload | 🔄 In progress |
| KYC integration | 📋 Planned |
| Frontend (Angular) integration | 📋 Planned |
| Mainnet deployment hardening | 📋 Planned |
| Audit (security + smart contracts) | 📋 Planned |

### v0.2 — Target: Q3 2026

- Complete unit test coverage (target 80%)
- Live Soroban testnet integration end-to-end
- Sensor simulator script for local development
- IPFS certificate upload on retirement confirmation

### v0.3 — Target: Q4 2026

- Angular frontend integration
- KYC provider integration
- Rate limiting and abuse protection hardening
- Performance benchmarks and query optimisation

### v1.0 — Target: Q1 2027

- Security audit complete
- Mainnet deployment
- Operator runbook and monitoring playbooks
- Public API documentation (OpenAPI / Swagger)

---

## 🤝 Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

### Quick Start

```bash
git clone https://github.com/water-credits/water-credits-backend
git checkout -b feat/your-feature

# Install
npm install

# Create database
createdb water_credits

# Run migrations
npm run migration:run

# Start
npm run start:dev

# Make changes, then:
npm run lint
npm test

# Commit and push
git commit -m "feat: add endpoint for batch credit issuance"
git push origin feat/your-feature
```

---

## 📬 Contact

| Channel | Details |
|---|---|
| **GitHub Issues** | Bug reports and feature requests — [open an issue](https://github.com/water-credits/water-credits-backend/issues) |
| **GitHub Discussions** | Questions, ideas, and general discussion — [start a discussion](https://github.com/water-credits/water-credits-backend/discussions) |
| **Telegram** | Direct questions and community chat — [@Escelit](https://t.me/Escelit) |
| **Email** | General enquiries — [ogazipromise81@gmail.com](mailto:ogazipromise81@gmail.com) |
| **Security vulnerabilities** | Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for the responsible disclosure process |

> For anything sensitive or urgent that can't go through GitHub, reach out to the maintainers directly via the contact details in [SECURITY.md](SECURITY.md).

---

## 📄 License

MIT — see [LICENSE](LICENSE).

---

<div align="center">
  <strong>Built with NestJS 🐦 + Stellar ✨</strong>
</div>
