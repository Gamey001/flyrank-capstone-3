import { Router } from 'express';
import { authService } from '../../services/auth.service.js';
import { requireAuth } from '../middleware/auth.js';
import { authRateLimit } from '../middleware/rate-limit.js';
import { validate } from '../middleware/validate.js';
import { loginSchema, registerSchema } from '../validators/auth.validators.js';

export const authRoutes = Router();

authRoutes.post('/register', authRateLimit, validate('body', registerSchema), async (req, res) => {
  const result = await authService.register(req.body);
  res.status(201).json(result);
});

authRoutes.post('/login', authRateLimit, validate('body', loginSchema), async (req, res) => {
  const result = await authService.login(req.body);
  res.json(result);
});

authRoutes.get('/me', requireAuth, (req, res) => {
  res.json({ tenant: req.tenant });
});
