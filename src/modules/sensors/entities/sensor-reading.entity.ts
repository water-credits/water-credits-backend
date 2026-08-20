import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { SensorDevice } from './sensor-device.entity';
import { Project } from '../../projects/entities/project.entity';
import { ReadingBatch } from './reading-batch.entity';

@Entity('sensor_readings')
export class SensorReading {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'device_id' })
  @Index()
  deviceId: string;

  @ManyToOne(() => SensorDevice, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'device_id' })
  device: SensorDevice;

  @Column({ name: 'project_id' })
  @Index()
  projectId: string;

  @ManyToOne(() => Project, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'project_id' })
  project: Project;

  @Column({ type: 'timestamptz' })
  @Index()
  timestamp: Date;

  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  ph: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  turbidity: number | null;

  @Column({ name: 'dissolved_oxygen', type: 'decimal', precision: 10, scale: 3, nullable: true })
  dissolvedOxygen: number | null;

  @Column({ name: 'flow_rate', type: 'decimal', precision: 10, scale: 3, nullable: true })
  flowRate: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  nitrogen: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  phosphorus: number | null;

  @Column({ type: 'decimal', precision: 10, scale: 3, nullable: true })
  temperature: number | null;

  @Column({ type: 'text' })
  signature: string;

  @Column({ name: 'is_verified', default: false })
  isVerified: boolean;

  /**
   * Timestamp marking when the ingestion processor finished fanning this
   * reading out over WebSocket (sensor:reading + sensor:alert events).
   * Used as an idempotency guard so a Bull retry never double-emits events
   * to connected clients.
   */
  @Column({ name: 'ws_emitted_at', type: 'timestamptz', nullable: true })
  wsEmittedAt: Date | null;

  @Column({ name: 'batch_id', nullable: true })
  @Index()
  batchId: string | null;

  @ManyToOne(() => ReadingBatch, { onDelete: 'SET NULL', nullable: true })
  @JoinColumn({ name: 'batch_id' })
  batch: ReadingBatch | null;

  @CreateDateColumn({ name: 'created_at' })
  createdAt: Date;
}
