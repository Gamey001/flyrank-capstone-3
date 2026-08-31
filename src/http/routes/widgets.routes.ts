import { Router } from 'express';
import { widgetsService } from '../../services/widgets.service.js';
import { requireAuth, tenantId } from '../middleware/auth.js';
import { validate, validatedQuery } from '../middleware/validate.js';
import { uuidParam } from '../validators/common.js';
import { createWidgetSchema, updateWidgetSchema, widgetListQuery } from '../validators/widget.validators.js';

export const widgetsRoutes = Router();

// On the router, not per route, so an endpoint added later is protected by
// default rather than by remembering.
widgetsRoutes.use(requireAuth);

widgetsRoutes.post('/', validate('body', createWidgetSchema), async (req, res) => {
  const widget = await widgetsService.create(tenantId(req), req.body);
  res.status(201).location(`/api/widgets/${widget.id}`).json({ widget });
});

widgetsRoutes.get('/', validate('query', widgetListQuery), async (req, res) => {
  const { limit, offset } = validatedQuery(req, widgetListQuery);
  const { items, total } = await widgetsService.list(tenantId(req), { limit, offset });
  res.json({ widgets: items, pagination: { total, limit, offset } });
});

widgetsRoutes.get('/:id', validate('params', uuidParam('id')), async (req, res) => {
  const widget = await widgetsService.get(tenantId(req), req.params.id as string);
  res.json({ widget });
});

widgetsRoutes.patch(
  '/:id',
  validate('params', uuidParam('id')),
  validate('body', updateWidgetSchema),
  async (req, res) => {
    const widget = await widgetsService.update(tenantId(req), req.params.id as string, req.body);
    res.json({ widget });
  },
);

widgetsRoutes.delete('/:id', validate('params', uuidParam('id')), async (req, res) => {
  await widgetsService.remove(tenantId(req), req.params.id as string);
  res.status(204).end();
});

widgetsRoutes.get('/:id/embed', validate('params', uuidParam('id')), async (req, res) => {
  const embed = await widgetsService.getEmbed(tenantId(req), req.params.id as string);
  res.json({ embed });
});
