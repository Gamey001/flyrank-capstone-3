import { env } from '../config/env.js';
import { closePool } from './pool.js';
import { runMigrations } from './migrate.js';
import { hashPassword } from '../lib/password.js';
import { publicWidgetId } from '../lib/ids.js';
import { tenantsRepository } from '../repositories/tenants.repository.js';
import { widgetsRepository, type CreateWidgetInput } from '../repositories/widgets.repository.js';
import { embedService } from '../services/embed.service.js';

/**
 * Demo data so a stranger can clone the repo, run two commands and immediately
 * have something to look at. Idempotent: re-running it reuses the existing
 * tenants and widgets rather than duplicating them.
 */

const DEMO_PASSWORD = 'demo-password-1234';

const seedTenant = async (email: string, name: string) => {
  const existing = await tenantsRepository.findByEmail(email);
  if (existing) return existing;
  return tenantsRepository.create({ email, name, passwordHash: await hashPassword(DEMO_PASSWORD) });
};

const seedWidget = async (
  tenantId: string,
  input: Omit<CreateWidgetInput, 'tenantId' | 'publicId'>,
) => {
  const { items } = await widgetsRepository.listForTenant(tenantId, { limit: 100, offset: 0 });
  const existing = items.find((widget) => widget.name === input.name);
  if (existing) return existing;
  return widgetsRepository.create({ ...input, tenantId, publicId: publicWidgetId() });
};

const main = async (): Promise<void> => {
  await runMigrations();

  const acme = await seedTenant('owner@acme.test', 'Acme Inc.');
  // A second tenant exists purely so multi-tenant isolation can be *proved*
  // rather than asserted — probe scripts and tests use it.
  const globex = await seedTenant('owner@globex.test', 'Globex Corp.');

  const newsletter = await seedWidget(acme.id, {
    name: 'Acme newsletter signup',
    type: 'signup_form',
    title: 'Join the Acme newsletter',
    description: 'Product news once a month. No spam, unsubscribe any time.',
    buttonText: 'Subscribe',
    successMessage: 'You are on the list — check your inbox.',
    fields: [
      { name: 'email', label: 'Email address', type: 'email', required: true, placeholder: 'you@example.com' },
      { name: 'first_name', label: 'First name', type: 'text', required: false, maxLength: 80 },
      { name: 'consent', label: 'I agree to receive emails', type: 'checkbox', required: true },
    ],
    display: { position: 'inline', theme: 'light', accentColor: '#4f46e5' },
    notifyEmail: 'leads@acme.test',
  });

  const contact = await seedWidget(acme.id, {
    name: 'Acme contact form',
    type: 'contact_form',
    title: 'Talk to sales',
    description: 'Tell us what you need and we will get back within one business day.',
    buttonText: 'Send message',
    fields: [
      { name: 'name', label: 'Your name', type: 'text', required: true, maxLength: 120 },
      { name: 'email', label: 'Work email', type: 'email', required: true },
      { name: 'company_size', label: 'Company size', type: 'select', required: false, options: ['1-10', '11-50', '51-200', '200+'] },
      { name: 'message', label: 'How can we help?', type: 'textarea', required: true, maxLength: 2000 },
    ],
    display: { position: 'inline', theme: 'light', accentColor: '#0f766e' },
    notifyEmail: 'sales@acme.test',
  });

  const globexWidget = await seedWidget(globex.id, {
    name: 'Globex waitlist',
    type: 'cta_popover',
    title: 'Get early access',
    description: 'We are onboarding in batches.',
    buttonText: 'Request access',
    fields: [{ name: 'email', label: 'Email address', type: 'email', required: true }],
    display: { position: 'bottom-right', theme: 'dark', accentColor: '#b45309', delaySeconds: 2 },
  });

  console.log(`
Seed complete.

  Login (both accounts share this password): ${DEMO_PASSWORD}

  Tenant A  owner@acme.test     ${acme.id}
    - ${newsletter.name}
        public id: ${newsletter.publicId}
        snippet:   ${embedService.forWidget(newsletter).snippet}
    - ${contact.name}
        public id: ${contact.publicId}
        snippet:   ${embedService.forWidget(contact).snippet}

  Tenant B  owner@globex.test   ${globex.id}
    - ${globexWidget.name}
        public id: ${globexWidget.publicId}

  Test page: npm run site   ->   http://localhost:5500
  API base:  ${env.PUBLIC_BASE_URL}
`);

  // Written to a file too, so scripts/probes.sh can pick the ids up without
  // scraping stdout.
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    'seed-output.json',
    JSON.stringify(
      {
        password: DEMO_PASSWORD,
        tenantA: { email: acme.email, id: acme.id },
        tenantB: { email: globex.email, id: globex.id },
        widgets: {
          newsletter: { id: newsletter.id, publicId: newsletter.publicId },
          contact: { id: contact.id, publicId: contact.publicId },
          globex: { id: globexWidget.id, publicId: globexWidget.publicId },
        },
      },
      null,
      2,
    ),
  );
};

try {
  await main();
  await closePool();
} catch (error) {
  console.error('Seed failed:', (error as Error).message);
  await closePool();
  process.exit(1);
}
