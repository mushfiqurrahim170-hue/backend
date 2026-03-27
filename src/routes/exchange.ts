import { Router } from 'express';
import { fetch } from 'undici';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

const getBaseUrl = (): string => {
  return process.env.BACKEND_BASE_URL || `http://127.0.0.1:${process.env.PORT || 8080}`;
};

const proxyExchangeApi = async (authHeader: string | undefined, body: Record<string, unknown>) => {
  const response = await fetch(`${getBaseUrl()}/api/exchange-api`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(authHeader ? { Authorization: authHeader } : {}),
    },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  return { status: response.status, data };
};

router.post('/balance', requireAuth, async (req, res) => {
  const { exchange, product, environment } = req.body as {
    exchange: string;
    product: string;
    environment: string;
  };

  const { status, data } = await proxyExchangeApi(req.headers.authorization, {
    action: 'getBalance',
    exchange,
    product,
    environment,
  });
  return res.status(status).json(data);
});

router.post('/positions', requireAuth, async (req, res) => {
  const { exchange, product, environment } = req.body as {
    exchange: string;
    product: string;
    environment: string;
  };

  const { status, data } = await proxyExchangeApi(req.headers.authorization, {
    action: 'getPositions',
    exchange,
    product,
    environment,
  });
  return res.status(status).json(data);
});

router.post('/place-order', requireAuth, async (_req, res) => {
  return res.status(501).json({ error: 'Not implemented' });
});

export const exchangeRouter = router;

