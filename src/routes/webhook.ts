import { Router } from 'express';
import { fetch } from 'undici';
import { db } from '../db/index.js';

const router = Router();

const getBaseUrl = (): string => {
  return process.env.BACKEND_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
};

router.post('/tradingview/:secret', async (req, res) => {
  const { secret } = req.params;

  try {
    const strategy = db.data?.trading_strategies.find(
      (s) => s.webhook_secret === secret && s.is_active
    );
    if (!strategy) {
      return res.status(404).json({ error: 'Strategy not found' });
    }

    const response = await fetch(`${getBaseUrl()}/api/tradingview-webhook`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...req.body,
        strategy_id: strategy.id,
        secret,
      }),
    });

    const text = await response.text();
    return res.status(response.status).send(text);
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
});

export const webhookRouter = router;

