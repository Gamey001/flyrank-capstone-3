import { Router } from 'express';
import { dashboardService } from '../../services/dashboard.service.js';
import { requireAuth, tenantId } from '../middleware/auth.js';
import { validate, validatedQuery } from '../middleware/validate.js';
import { uuidParam } from '../validators/common.js';
import { statsQuery, submissionListQuery } from '../validators/dashboard.validators.js';

export const dashboardRoutes = Router();

dashboardRoutes.use(requireAuth);

dashboardRoutes.get('/submissions', validate('query', submissionListQuery), async (req, res) => {
  const query = validatedQuery(req, submissionListQuery);
  const { items, total } = await dashboardService.listSubmissions(tenantId(req), query);

  res.setHeader('cache-control', 'private, no-store');
  res.json({
    submissions: items,
    pagination: { total, limit: query.limit, offset: query.offset },
  });
});

dashboardRoutes.get('/submissions/:id', validate('params', uuidParam('id')), async (req, res) => {
  const submission = await dashboardService.getSubmission(tenantId(req), req.params.id as string);
  res.setHeader('cache-control', 'private, no-store');
  res.json({ submission });
});

dashboardRoutes.get('/stats', validate('query', statsQuery), async (req, res) => {
  const query = validatedQuery(req, statsQuery);
  const stats = await dashboardService.stats(tenantId(req), query);
  res.setHeader('cache-control', 'private, no-store');
  res.json(stats);
});
