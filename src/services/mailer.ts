import nodemailer, { type Transporter } from 'nodemailer';
import { env } from '../config/env.js';
import { logger } from '../lib/logger.js';

export interface OutgoingEmail {
  to: string;
  subject: string;
  text: string;
}

export interface Mailer {
  readonly kind: string;
  send(email: OutgoingEmail): Promise<void>;
}

const logMailer: Mailer = {
  kind: 'log',
  async send(email) {
    logger.info({ to: email.to, subject: email.subject, body: email.text }, '[email] delivered to log');
  },
};

// A demo switch, not a fallback: it exists so a broken side effect can be
// demonstrated without editing code. Never configure it outside a demo.
const failingMailer: Mailer = {
  kind: 'fail',
  async send() {
    throw new Error('EMAIL_TRANSPORT=fail: simulated mail provider outage');
  },
};

const smtpMailer = (): Mailer => {
  let transporter: Transporter | null = null;

  return {
    kind: 'smtp',
    async send(email) {
      // Lazy, so a misconfigured SMTP host cannot stop the API booting.
      transporter ??= nodemailer.createTransport({
        host: env.SMTP_HOST,
        port: env.SMTP_PORT,
        secure: false,
        auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD ?? '' } : undefined,
      });
      await transporter.sendMail({ from: env.EMAIL_FROM, ...email });
    },
  };
};

const build = (): Mailer => {
  switch (env.EMAIL_TRANSPORT) {
    case 'smtp':
      return smtpMailer();
    case 'fail':
      return failingMailer;
    default:
      return logMailer;
  }
};

export const mailer: Mailer = build();
