import { Test, TestingModule } from '@nestjs/testing';
import { ConfigService } from '@nestjs/config';
import { EmailService } from './email.service';
import * as nodemailer from 'nodemailer';

jest.mock('nodemailer');

describe('EmailService', () => {
  let service: EmailService;
  let mockConfigService: jest.Mocked<ConfigService>;
  let mockTransporter: any;

  beforeEach(async () => {
    mockConfigService = {
      get: jest.fn().mockImplementation((key: string, def?: any) => def),
    } as any;

    mockTransporter = {
      sendMail: jest.fn().mockResolvedValue(true),
    };
    (nodemailer.createTransport as jest.Mock).mockReturnValue(mockTransporter);

    const module: TestingModule = await Test.createTestingModule({
      providers: [EmailService, { provide: ConfigService, useValue: mockConfigService }],
    }).compile();

    service = module.get<EmailService>(EmailService);
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  it('should be defined', () => {
    expect(service).toBeDefined();
  });

  it('should initialize transporter when SMTP_HOST is set', () => {
    mockConfigService.get.mockImplementation((key: string, def?: any) => {
      if (key === 'email.host') {
        return 'smtp.example.com';
      }
      if (key === 'email.port') {
        return 587;
      }
      if (key === 'email.user') {
        return 'testuser';
      }
      if (key === 'email.pass') {
        return 'testpass';
      }
      if (key === 'email.from') {
        return 'noreply@example.com';
      }
      return def;
    });

    service.onModuleInit();
    expect(nodemailer.createTransport).toHaveBeenCalledWith({
      host: 'smtp.example.com',
      port: 587,
      auth: {
        user: 'testuser',
        pass: 'testpass',
      },
    });
  });

  it('should not initialize transporter when SMTP_HOST is missing', () => {
    mockConfigService.get.mockImplementation((key: string, def?: any) => {
      if (key === 'email.host') {
        return undefined;
      }
      return def;
    });

    service.onModuleInit();
    expect(nodemailer.createTransport).not.toHaveBeenCalled();
  });

  it('should send email if transporter is initialized', async () => {
    mockConfigService.get.mockImplementation((key: string, def?: any) => {
      if (key === 'email.host') {
        return 'smtp.example.com';
      }
      if (key === 'email.from') {
        return 'noreply@example.com';
      }
      return def;
    });

    service.onModuleInit();
    await service.sendMail('test@example.com', 'Test Subject', 'Test body');

    expect(mockTransporter.sendMail).toHaveBeenCalledWith({
      from: 'noreply@water-credits.io',
      to: 'test@example.com',
      subject: 'Test Subject',
      text: 'Test body',
      html: undefined,
    });
  });

  it('should drop email silently if transporter is not initialized', async () => {
    mockConfigService.get.mockImplementation((key: string, def?: any) => {
      if (key === 'email.host') {
        return undefined;
      }
      return def;
    });

    service.onModuleInit();
    await service.sendMail('test@example.com', 'Test Subject', 'Test body');

    expect(mockTransporter.sendMail).not.toHaveBeenCalled();
  });
});
