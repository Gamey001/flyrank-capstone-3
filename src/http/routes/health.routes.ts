import { Router } from 'express';
import { pool } from '../../db/pool.js';
import { jobsRepository } from '../../repositories/jobs.repository.js';
import { widgetAsset } from '../../services/widget-asset.service.js';

export const healthRoutes = Router();

// Liveness: deliberately touches no dependency.
healthRoutes.get('/healthz', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  res.json({ status: 'ok', uptimeSeconds: Math.round(process.uptime()) });
});

// Readiness: checks the dependency this service cannot work without, so an
// orchestrator stops routing here instead of letting it serve 500s.
healthRoutes.get('/readyz', async (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  try {
    await pool.query('SELECT 1');
    const jobs = await jobsRepository.counts();
    res.json({ status: 'ready', database: 'ok', widgetVersion: widgetAsset.version, jobs });
  } catch (error) {
    res.status(503).json({ status: 'unavailable', database: 'unreachable', reason: (error as Error).message });
  }
});
