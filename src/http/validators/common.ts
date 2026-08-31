import { z } from 'zod';

export const uuidParam = (name: string): z.ZodObject<Record<string, z.ZodString>> =>
  z.object({ [name]: z.string().uuid(`${name} must be a UUID`) });

export const paginationQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  offset: z.coerce.number().int().min(0).default(0),
});

export type Pagination = z.infer<typeof paginationQuery>;
