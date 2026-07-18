declare module 'typeorm' {
  export interface Repository<T> {
    [key: string]: any;
  }

  export function InjectRepository(): any;
  export function Entity(...args: any[]): any;
  export function Column(...args: any[]): any;
  export function PrimaryGeneratedColumn(...args: any[]): any;
  export function CreateDateColumn(...args: any[]): any;
  export function UpdateDateColumn(...args: any[]): any;
  export function OneToMany(...args: any[]): any;
  export function ManyToOne(...args: any[]): any;
  export function JoinColumn(...args: any[]): any;
  export function Index(...args: any[]): any;
  export function Unique(...args: any[]): any;
  export function PrimaryColumn(...args: any[]): any;
  export function Generated(...args: any[]): any;
  export function VersionColumn(...args: any[]): any;
  export function DeleteDateColumn(...args: any[]): any;
  export function BeforeInsert(...args: any[]): any;
  export function BeforeUpdate(...args: any[]): any;
  export function AfterLoad(...args: any[]): any;
  export function BaseEntity(...args: any[]): any;

  export function getRepositoryToken(entity: any): string;
  export interface ObjectLiteral {
    [key: string]: any;
  }
  export class DataSource {}
}
