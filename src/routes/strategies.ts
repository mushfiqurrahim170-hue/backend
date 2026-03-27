import { Router } from 'express';
import { db, safeWrite } from '../db/index.js';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';

const router = Router();

router.get('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const rows = (db.data?.trading_strategies || []).filter((s) => s.user_id === req.user?.id);
    return res.json(rows);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const strategy = {
      id: crypto.randomUUID(),
      user_id: req.user?.id as string,
      is_active: true,
      ...req.body,
    };
    db.data?.trading_strategies.push(strategy);
    await safeWrite();
    return res.json(strategy);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const strategiesRouter = router;

