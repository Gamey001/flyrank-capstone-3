import { z } from 'zod';

const fieldName = z
  .string()
  .trim()
  .min(1)
  .max(64)
  // The name becomes an HTML input name, a JSON key, and a dashboard column
  // header. Restricting it here keeps all three well behaved.
  .regex(/^[a-z][a-z0-9_]*$/i, 'Field names must start with a letter and contain only letters, digits and _');

export const widgetFieldSchema = z
  .object({
    name: fieldName,
    label: z.string().trim().min(1).max(120),
    type: z.enum(['text', 'email', 'tel', 'textarea', 'select', 'checkbox']),
    required: z.boolean().default(false),
    placeholder: z.string().trim().max(160).optional(),
    options: z.array(z.string().trim().min(1).max(120)).max(50).optional(),
    maxLength: z.number().int().min(1).max(5000).optional(),
  })
  .strict()
  .refine((field) => field.type !== 'select' || (field.options?.length ?? 0) > 0, {
    message: 'A select field needs at least one option',
    path: ['options'],
  });

export const widgetDisplaySchema = z
  .object({
    position: z.enum(['inline', 'bottom-right', 'bottom-left']).optional(),
    theme: z.enum(['light', 'dark']).optional(),
    accentColor: z
      .string()
      .regex(/^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/i, 'accentColor must be a hex colour like #4f46e5')
      .optional(),
    delaySeconds: z.number().int().min(0).max(120).optional(),
  })
  .strict();

// Only http(s) — a webhook URL is fetched by the server, so allowing other
// schemes would let a tenant point it at something it should not reach.
const httpUrl = z
  .string()
  .trim()
  .url()
  .max(2048)
  .refine((value) => /^https?:\/\//i.test(value), { message: 'Must be an http(s) URL' });

const originUrl = z
  .string()
  .trim()
  .max(255)
  .refine(
    (value) => value === '*' || /^https?:\/\/[^/]+$/i.test(value),
    'Each origin must be a scheme + host + optional port, with no path (e.g. https://example.com)',
  );

// The shape both create and update share. Keeping it as a plain object (rather
// than deriving update from a refined create schema) means `.partial()` still
// works and the cross-field rules can be stated once, below.
const widgetBaseSchema = z
  .object({
    name: z.string().trim().min(1).max(120),
    type: z.enum(['signup_form', 'contact_form', 'cta_popover']),
    status: z.enum(['active', 'paused']).optional(),
    title: z.string().trim().min(1).max(160),
    description: z.string().trim().max(500).nullish(),
    buttonText: z.string().trim().min(1).max(60).optional(),
    successMessage: z.string().trim().min(1).max(300).optional(),
    fields: z.array(widgetFieldSchema).min(1, 'A widget needs at least one field').max(25),
    display: widgetDisplaySchema.optional(),
    honeypotField: fieldName.optional(),
    allowedOrigins: z.array(originUrl).max(50).optional(),
    webhookUrl: httpUrl.nullish(),
    notifyEmail: z.string().trim().toLowerCase().email().max(320).nullish(),
  })
  .strict();

type WidgetPatch = Partial<z.infer<typeof widgetBaseSchema>>;

/**
 * Rules that span more than one field. Applied to create and update alike, so
 * a PATCH cannot sneak past a constraint a POST has to satisfy.
 */
const crossFieldRules = (widget: WidgetPatch, ctx: z.RefinementCtx): void => {
  if (widget.fields) {
    const names = widget.fields.map((field) => field.name);
    if (new Set(names).size !== names.length) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fields'], message: 'Field names must be unique' });
    }
    // A honeypot named like a real field would be stripped from the payload
    // before storage and silently lose the visitor's answer.
    const honeypot = widget.honeypotField ?? 'company_website';
    if (names.includes(honeypot)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['honeypotField'],
        message: 'The honeypot field name must not collide with a real field',
      });
    }
  }
};

export const createWidgetSchema = widgetBaseSchema.superRefine(crossFieldRules);

export const updateWidgetSchema = widgetBaseSchema
  .partial()
  .strict()
  .superRefine(crossFieldRules)
  .refine((patch) => Object.keys(patch).length > 0, { message: 'Provide at least one field to update' });

export const widgetListQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});
