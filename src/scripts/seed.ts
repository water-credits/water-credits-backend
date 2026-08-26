/**
 * Demo data seed script
 *
 * Populates the database with realistic demo data for development and
 * staging environments. Safe to run multiple times — it checks for
 * existing records before inserting.
 *
 * Usage:
 *   npx ts-node -r tsconfig-paths/register src/scripts/seed.ts
 *
 * Environment variables required (same as the main app):
 *   DATABASE_HOST, DATABASE_PORT, DATABASE_NAME, DATABASE_USER, DATABASE_PASSWORD
 */
/* eslint-disable no-console */

import 'reflect-metadata';
import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

// ── Entity imports ────────────────────────────────────────────────────────────
import { User, UserRole } from '../modules/users/entities/user.entity';
import { Project, ProjectStatus } from '../modules/projects/entities/project.entity';
import { SensorDevice } from '../modules/sensors/entities/sensor-device.entity';
import { SensorReading } from '../modules/sensors/entities/sensor-reading.entity';
import { ReadingBatch, BatchStatus } from '../modules/sensors/entities/reading-batch.entity';
import { Retirement } from '../modules/credits/entities/retirement.entity';
import { Proposal, ProposalStatus } from '../modules/governance/entities/proposal.entity';
import { GovernanceConfig } from '../modules/governance/entities/governance-config.entity';

// ── Data source ───────────────────────────────────────────────────────────────

const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DATABASE_HOST ?? 'localhost',
  port: parseInt(process.env.DATABASE_PORT ?? '5432', 10),
  username: process.env.DATABASE_USER ?? 'postgres',
  password: process.env.DATABASE_PASSWORD ?? 'postgres',
  database: process.env.DATABASE_NAME ?? 'water_credits',
  synchronize: false,
  logging: false,
  entities: [
    User,
    Project,
    SensorDevice,
    SensorReading,
    ReadingBatch,
    Retirement,
    Proposal,
    GovernanceConfig,
  ],
});

// ── Seed helpers ─────────────────────────────────────────────────────────────

function randomBetween(min: number, max: number, decimals = 2): number {
  const val = min + Math.random() * (max - min);
  return parseFloat(val.toFixed(decimals));
}

function daysAgo(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() - n);
  return d;
}

function daysFromNow(n: number): Date {
  const d = new Date();
  d.setDate(d.getDate() + n);
  return d;
}

// ── Seed data definitions ─────────────────────────────────────────────────────

const DEMO_USERS: Partial<User>[] = [
  {
    wallet: 'GADMIN111111111111111111111111111111111111111111111111111',
    email: 'admin@watercredits.dev',
    displayName: 'Platform Admin',
    role: UserRole.ADMIN,
    isKycVerified: true,
  },
  {
    wallet: 'GOWNER111111111111111111111111111111111111111111111111111',
    email: 'alice@greenvalley.example',
    displayName: 'Alice Farmer',
    role: UserRole.FARMER,
    isKycVerified: true,
  },
  {
    wallet: 'GOWNER222222222222222222222222222222222222222222222222222',
    email: 'bob@riverhealth.example',
    displayName: 'Bob Project Owner',
    role: UserRole.PROJECT_OWNER,
    isKycVerified: true,
  },
  {
    wallet: 'GORACLE11111111111111111111111111111111111111111111111111',
    email: 'oracle@watercredits.dev',
    displayName: 'Oracle Node 1',
    role: UserRole.ORACLE,
    isKycVerified: false,
  },
  {
    wallet: 'GVERIFIER1111111111111111111111111111111111111111111111111',
    email: 'verifier@watercredits.dev',
    displayName: 'Independent Verifier',
    role: UserRole.VERIFIER,
    isKycVerified: true,
  },
];

// ── Main seed function ────────────────────────────────────────────────────────

async function seed(): Promise<void> {
  await AppDataSource.initialize();
  console.log('✅ Connected to database');

  const userRepo = AppDataSource.getRepository(User);
  const projectRepo = AppDataSource.getRepository(Project);
  const deviceRepo = AppDataSource.getRepository(SensorDevice);
  const readingRepo = AppDataSource.getRepository(SensorReading);
  const batchRepo = AppDataSource.getRepository(ReadingBatch);
  const retirementRepo = AppDataSource.getRepository(Retirement);
  const proposalRepo = AppDataSource.getRepository(Proposal);
  const configRepo = AppDataSource.getRepository(GovernanceConfig);

  // ─── Users ─────────────────────────────────────────────────────────────────
  console.log('\n── Seeding users…');
  const savedUsers: User[] = [];
  for (const u of DEMO_USERS) {
    const existing = await userRepo.findOne({ where: { wallet: u.wallet! } });
    if (existing) {
      console.log(`  skip existing user ${u.displayName}`);
      savedUsers.push(existing);
      continue;
    }
    const user = userRepo.create(u);
    const saved = await userRepo.save(user);
    savedUsers.push(saved);
    console.log(`  created ${saved.displayName} (${saved.role})`);
  }

  const adminUser = savedUsers[0];
  const farmerUser = savedUsers[1];
  const ownerUser = savedUsers[2];
  const buyerUser = savedUsers[0]; // admin doubles as buyer in demo

  // ─── Projects ──────────────────────────────────────────────────────────────
  console.log('\n── Seeding projects…');

  const projectDefs: Partial<Project>[] = [
    {
      ownerId: farmerUser.id,
      name: 'Green Valley Wetland Restoration',
      description:
        'Restoring 280 ha of degraded wetland in the Green Valley watershed. ' +
        'Project targets improvements in water quality metrics including pH, dissolved oxygen, ' +
        'and nutrient levels through natural wetland filtering.',
      latitude: 38.8977,
      longitude: -77.0365,
      methodology: 'Wetland_Restoration_v2',
      status: ProjectStatus.ACTIVE,
      areaHectares: 280,
      baselineStartDate: daysAgo(120),
      baselineEndDate: daysAgo(90),
    },
    {
      ownerId: ownerUser.id,
      name: 'Rio Claro Riparian Buffer',
      description:
        'Planting native vegetation along 12 km of the Rio Claro river to reduce ' +
        'agricultural runoff, lower nitrogen and phosphorus loads, and stabilise ' +
        'streambank erosion.',
      latitude: -22.4149,
      longitude: -47.5651,
      methodology: 'Riparian_Buffer_v1',
      status: ProjectStatus.BASELINE,
      areaHectares: 48,
      baselineStartDate: daysAgo(30),
      baselineEndDate: null,
    },
    {
      ownerId: ownerUser.id,
      name: 'Murray-Darling Floodplain Reconnection',
      description:
        'Removing levee banks on 150 ha of floodplain to reconnect the river to its ' +
        'natural flow regime, improving ecological water flows and dissolved oxygen levels.',
      latitude: -35.103,
      longitude: 143.652,
      methodology: 'Floodplain_Reconnection_v1',
      status: ProjectStatus.REGISTERED,
      areaHectares: 150,
      baselineStartDate: null,
      baselineEndDate: null,
    },
  ];

  const savedProjects: Project[] = [];
  for (const def of projectDefs) {
    const existing = await projectRepo.findOne({ where: { name: def.name! } });
    if (existing) {
      console.log(`  skip existing project "${existing.name}"`);
      savedProjects.push(existing);
      continue;
    }
    const project = projectRepo.create(def);
    const saved = await projectRepo.save(project);
    savedProjects.push(saved);
    console.log(`  created "${saved.name}" (${saved.status})`);
  }

  const activeProject = savedProjects[0];

  // ─── Sensor devices ────────────────────────────────────────────────────────
  console.log('\n── Seeding sensor devices…');

  const deviceDefs: Partial<SensorDevice>[] = [
    {
      projectId: activeProject.id,
      deviceId: 'sensor-gv-001',
      manufacturer: 'YSI',
      model: 'ProDSS',
      publicKey: 'GORACLE11111111111111111111111111111111111111111111111111',
      parameters: { ph: true, turbidity: true, dissolvedOxygen: true, temperature: true },
      isActive: true,
    },
    {
      projectId: activeProject.id,
      deviceId: 'sensor-gv-002',
      manufacturer: 'Hach',
      model: 'Sonde 600',
      publicKey: 'GORACLE11111111111111111111111111111111111111111111111111',
      parameters: { flowRate: true, nitrogen: true, phosphorus: true },
      isActive: true,
    },
  ];

  const savedDevices: SensorDevice[] = [];
  for (const def of deviceDefs) {
    const existing = await deviceRepo.findOne({ where: { deviceId: def.deviceId! } });
    if (existing) {
      console.log(`  skip existing device ${existing.deviceId}`);
      savedDevices.push(existing);
      continue;
    }
    const device = deviceRepo.create(def);
    const saved = await deviceRepo.save(device);
    savedDevices.push(saved);
    console.log(`  created device ${saved.deviceId}`);
  }

  // ─── Sensor readings (last 7 days, 6 readings/day per device) ──────────────
  console.log('\n── Seeding sensor readings…');

  let totalReadings = 0;
  for (const device of savedDevices) {
    // create one batch per device for the demo
    const existingBatch = await batchRepo.findOne({ where: { projectId: activeProject.id } });
    let batch = existingBatch;
    if (!batch) {
      batch = await batchRepo.save(
        batchRepo.create({
          projectId: activeProject.id,
          status: BatchStatus.PENDING,
          readingCount: 0,
        }),
      );
    }

    const existingCount = await readingRepo.count({ where: { deviceId: device.id } });
    if (existingCount >= 42) {
      console.log(`  skip readings for device ${device.deviceId} (already seeded)`);
      continue;
    }

    const readings: Partial<SensorReading>[] = [];
    for (let day = 7; day >= 0; day--) {
      for (let hour = 0; hour < 24; hour += 4) {
        const ts = daysAgo(day);
        ts.setHours(hour, 0, 0, 0);

        readings.push({
          deviceId: device.id,
          projectId: activeProject.id,
          timestamp: ts,
          ph: randomBetween(6.8, 8.2),
          turbidity: randomBetween(2, 18),
          dissolvedOxygen: randomBetween(5.5, 9.5),
          flowRate: randomBetween(0.8, 3.2),
          nitrogen: randomBetween(1.0, 3.5),
          phosphorus: randomBetween(0.05, 0.25),
          temperature: randomBetween(14, 22),
          signature: 'demo_signature_not_verified',
          isVerified: false,
          batchId: batch!.id,
        });
      }
    }

    const chunks = [];
    for (let i = 0; i < readings.length; i += 50) {
      chunks.push(readings.slice(i, i + 50));
    }
    for (const chunk of chunks) {
      await readingRepo.save(chunk);
    }
    await batchRepo.update(batch!.id, { readingCount: readings.length });
    totalReadings += readings.length;
    console.log(`  created ${readings.length} readings for device ${device.deviceId}`);
  }

  // ─── Retirements ───────────────────────────────────────────────────────────
  console.log('\n── Seeding retirements…');

  const retirementDefs: Partial<Retirement>[] = [
    {
      userId: buyerUser.id,
      projectId: activeProject.id,
      amount: 1000,
      purpose: 'compliance',
      metadataUri: 'ipfs://QmDemoRetirement001',
      txHash: 'aabbccdd0011223344556677889900aabbccdd0011223344556677889900aabb',
      certificateIpfsUri: 'ipfs://QmDemoCert001',
      retiredAt: daysAgo(10),
    },
    {
      userId: buyerUser.id,
      projectId: activeProject.id,
      amount: 500,
      purpose: 'voluntary',
      metadataUri: 'ipfs://QmDemoRetirement002',
      txHash: 'bbccddee1122334455667788990011bbccddee1122334455667788990011bbcc',
      certificateIpfsUri: 'ipfs://QmDemoCert002',
      retiredAt: daysAgo(3),
    },
  ];

  for (const def of retirementDefs) {
    const existing = await retirementRepo.findOne({ where: { txHash: def.txHash! } });
    if (existing) {
      console.log(`  skip existing retirement ${def.txHash!.slice(0, 12)}…`);
      continue;
    }
    const retirement = retirementRepo.create(def);
    await retirementRepo.save(retirement);
    console.log(`  created retirement of ${def.amount} credits (${def.purpose})`);
  }

  // ─── Governance config ─────────────────────────────────────────────────────
  console.log('\n── Seeding governance config…');
  const existingConfig = await configRepo.findOne({ where: { id: 1 } });
  if (existingConfig) {
    console.log('  governance_config row already exists — skipping');
  } else {
    await configRepo.save(
      configRepo.create({
        id: 1,
        protocolFeeBps: 100,
        minOracleConfirmations: 3,
        votingPeriod: 604800,
        timelockPeriod: 86400,
        quorum: 3,
        phMin: 6.0,
        phMax: 9.0,
        doThreshold: 5.0,
        tempPenaltyDelta: 2.0,
        weightVolumetric: 0.5,
        weightNitrogen: 0.3,
        weightPhosphorus: 0.2,
        phPenaltyFactor: 1.0,
        tempPenaltyFactor: 1.0,
        nutrientDivisor: 10.0,
      }),
    );
    console.log('  created governance_config row');
  }

  // ─── Proposals ─────────────────────────────────────────────────────────────
  console.log('\n── Seeding governance proposals…');

  const proposalDefs: Partial<Proposal>[] = [
    {
      proposer: adminUser.wallet,
      title: 'Increase oracle minimum confirmations to 5',
      description:
        'As the oracle network grows, raising the minimum confirmation threshold ' +
        'from 3 to 5 improves Sybil resistance and submission quality.',
      actionType: 'update_oracle_threshold',
      actionParams: { min_oracle_confirmations: 5 },
      votesFor: 12,
      votesAgainst: 3,
      status: ProposalStatus.ACTIVE,
      deadline: daysFromNow(5),
    },
    {
      proposer: ownerUser.wallet,
      title: 'Reduce protocol fee from 1% to 0.75%',
      description:
        'Lower the protocol fee bps from 100 to 75 to make the platform more ' +
        'competitive against alternative MRV systems.',
      actionType: 'update_protocol_fee',
      actionParams: { protocol_fee_bps: 75 },
      votesFor: 8,
      votesAgainst: 9,
      status: ProposalStatus.REJECTED,
      deadline: daysAgo(7),
    },
    {
      proposer: adminUser.wallet,
      title: 'Add dissolved oxygen weight parameter',
      description:
        'Introduce a weight_dissolved_oxygen parameter to the credit scoring formula ' +
        'to better reward projects that measurably improve DO levels.',
      actionType: 'update_credit_weights',
      actionParams: { weight_dissolved_oxygen: 0.15 },
      votesFor: 0,
      votesAgainst: 0,
      status: ProposalStatus.ACTIVE,
      deadline: daysFromNow(14),
    },
  ];

  for (const def of proposalDefs) {
    const existing = await proposalRepo.findOne({ where: { title: def.title! } });
    if (existing) {
      console.log(`  skip existing proposal "${existing.title}"`);
      continue;
    }
    const proposal = proposalRepo.create(def);
    await proposalRepo.save(proposal);
    console.log(`  created proposal "${def.title}" (${def.status})`);
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  console.log('\n✅ Seed complete');
  console.log(`   users:      ${savedUsers.length}`);
  console.log(`   projects:   ${savedProjects.length}`);
  console.log(`   devices:    ${savedDevices.length}`);
  console.log(`   readings:   ${totalReadings} new`);
  console.log(`   retirements: ${retirementDefs.length}`);
  console.log(`   proposals:  ${proposalDefs.length}`);

  await AppDataSource.destroy();
}

seed().catch((err) => {
  console.error('❌ Seed failed:', err);
  process.exit(1);
});
