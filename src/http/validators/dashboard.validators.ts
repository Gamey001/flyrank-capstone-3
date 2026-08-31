import { z } from 'zod';

export const submissionListQuery = z
  .object({
    widgetId: z.string().uuid().optional(),
    status: z.enum(['stored', 'spam']).optional(),
    from: z.coerce.date().optional(),
    to: z.coerce.date().optional(),
    limit: z.coerce.number().int().min(1).max(100).default(25),
    offset: z.coerce.number().int().min(0).default(0),
  })
  .refine((query) => !query.from || !query.to || query.from <= query.to, {
    message: '`from` must be before `to`',
    path: ['from'],
  });

export const statsQuery = z.object({
  days: z.coerce.number().int().min(1).max(365).default(30),
  // Hourly buckets over a year would be 8,760 points — useless to plot and
  // expensive to build, so the caller picks the resolution explicitly.
  granularity: z.enum(['hour', 'day']).default('day'),
});
