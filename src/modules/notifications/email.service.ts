import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as nodemailer from 'nodemailer';

@Injectable()
export class EmailService implements OnModuleInit {
  private readonly logger = new Logger(EmailService.name);
  private transporter: nodemailer.Transporter | null = null;
  private fromAddress: string;

  constructor(private readonly configService: ConfigService) {
    this.fromAddress = this.configService.get<string>('email.from', 'noreply@water-credits.io');
  }

  onModuleInit() {
    const host = this.configService.get<string>('email.host');
    if (!host) {
      this.logger.warn('SMTP_HOST is not set; email delivery is disabled (silent no-op)');
      return;
    }

    this.transporter = nodemailer.createTransport({
      host,
      port: this.configService.get<number>('email.port', 587),
      auth: {
        user: this.configService.get<string>('email.user'),
        pass: this.configService.get<string>('email.pass'),
      },
    });
    this.logger.log(`Email transport initialized via ${host}`);
  }

  async sendMail(to: string, subject: string, text: string, html?: string): Promise<void> {
    if (!this.transporter) {
      this.logger.debug(`Email silently dropped (no transport): To=${to} Subject="${subject}"`);
      return;
    }

    try {
      await this.transporter.sendMail({
        from: this.fromAddress,
        to,
        subject,
        text,
        html,
      });
      this.logger.debug(`Email sent to ${to}: "${subject}"`);
    } catch (error) {
      this.logger.error(`Failed to send email to ${to}: ${(error as Error).message}`);
    }
  }
}
