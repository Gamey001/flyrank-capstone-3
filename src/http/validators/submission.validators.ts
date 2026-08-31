import { z } from 'zod';

// The envelope only. `data`'s contents are validated separately against the
// widget's own field definitions, once the widget has been loaded.
export const submissionSchema = z
  .object({
    widgetId: z
      .string()
      .trim()
      .min(8)
      .max(64)
      .regex(/^[a-z0-9]+$/i, 'widgetId is not a valid public widget id'),
    data: z.record(z.union([z.string().max(5000), z.boolean(), z.number()])).refine(
      (data) => Object.keys(data).length <= 60,
      'Too many fields in the submission',
    ),
    elapsedMs: z.number().int().min(0).max(86_400_000).optional(),
    pageUrl: z.string().trim().max(2048).optional(),
  })
  .strict();

export type SubmissionRequest = z.infer<typeof submissionSchema>;

export const publicWidgetIdParam = z.object({
  publicId: z
    .string()
    .trim()
    .min(8)
    .max(64)
    .regex(/^[a-z0-9]+$/i, 'Not a valid widget id'),
});
