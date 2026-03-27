import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { fetch } from 'undici';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { db, safeWrite } from '../db/index.js';

const router = Router();

interface ApiKeyData {
  api_key_encrypted: string;
  api_secret_encrypted: string;
  exchange: string;
  product: string;
  environment: string;
}

const decryptValue = (encrypted: string): string => {
  try {
    const decoded = Buffer.from(encrypted, 'base64').toString('utf-8');
    return decoded || encrypted;
  } catch {
    return encrypted;
  }
};

const createBinanceSignature = (queryString: string, secret: string): string => {
  const hmac = createHmac('sha256', secret);
  hmac.update(queryString);
  return hmac.digest('hex');
};

const callBinanceApi = async (
  endpoint: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  product: string,
  method = 'GET',
  params: Record<string, string> = {}
): Promise<Response> => {
  const baseUrl =
    product === 'futures'
      ? isTestnet
        ? 'https://testnet.binancefuture.com'
        : 'https://fapi.binance.com'
      : isTestnet
        ? 'https://testnet.binance.vision'
        : 'https://api.binance.com';

  const timestamp = Date.now().toString();
  const queryParams = new URLSearchParams({ ...params, timestamp });
  const signature = createBinanceSignature(queryParams.toString(), apiSecret);
  queryParams.append('signature', signature);

  const url = `${baseUrl}${endpoint}?${queryParams.toString()}`;
  return fetch(url, {
    method,
    headers: {
      'X-MBX-APIKEY': apiKey,
      'Content-Type': 'application/json',
    },
  });
};

const createBybitSignature = (
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  queryString: string,
  secret: string
): string => {
  const payload = timestamp + apiKey + recvWindow + queryString;
  const hmac = createHmac('sha256', secret);
  hmac.update(payload);
  return hmac.digest('hex');
};

const callBybitApi = async (
  endpoint: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  method = 'GET',
  params: Record<string, string> = {}
): Promise<Response> => {
  const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  const queryString = new URLSearchParams(params).toString();
  const signature = createBybitSignature(timestamp, apiKey, recvWindow, queryString, apiSecret);

  const url = `${baseUrl}${endpoint}${queryString ? '?' + queryString : ''}`;
  return fetch(url, {
    method,
    headers: {
      'X-BAPI-API-KEY': apiKey,
      'X-BAPI-TIMESTAMP': timestamp,
      'X-BAPI-RECV-WINDOW': recvWindow,
      'X-BAPI-SIGN': signature,
      'Content-Type': 'application/json',
    },
  });
};

router.post('/', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { action, exchange, product, environment, symbol } = req.body as {
      action: string;
      exchange: string;
      product: string;
      environment: string;
      symbol?: string;
    };

    if (!req.user) {
      return res.status(401).json({ code: 401, message: 'Unauthorized' });
    }

    const userId = req.user.id;
    const apiKeyData = db.data?.api_keys.find(
      (k) =>
        k.user_id === userId &&
        k.exchange === exchange &&
        k.product === product &&
        k.environment === environment &&
        k.is_active
    ) as ApiKeyData | undefined;

    if (!apiKeyData) {
      return res.status(400).json({ error: 'API keys not configured' });
    }

    const apiKey = decryptValue(apiKeyData.api_key_encrypted);
    const apiSecret = decryptValue(apiKeyData.api_secret_encrypted);
    const isTestnet = environment === 'testnet';

    let result: unknown;

    if (exchange === 'binance') {
      switch (action) {
        case 'getBalance': {
          const endpoint = product === 'futures' ? '/fapi/v2/balance' : '/api/v3/account';
          const response = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product);
          result = await response.json();
          break;
        }
        case 'getPositions': {
          if (product === 'futures') {
            const response = await callBinanceApi('/fapi/v2/positionRisk', apiKey, apiSecret, isTestnet, product);
            result = await response.json();
          } else {
            result = [];
          }
          break;
        }
        case 'getOrders': {
          if (product === 'futures') {
            const response = await callBinanceApi('/fapi/v1/allOrders', apiKey, apiSecret, isTestnet, product, 'GET', { limit: '100' });
            result = await response.json();
          } else {
            result = [];
          }
          break;
        }
        case 'getTrades': {
          if (product === 'futures') {
            const response = await callBinanceApi('/fapi/v1/userTrades', apiKey, apiSecret, isTestnet, product, 'GET', { limit: '100' });
            result = await response.json();
          } else {
            result = [];
          }
          break;
        }
        case 'getAccountInfo': {
          const endpoint = product === 'futures' ? '/fapi/v2/account' : '/api/v3/account';
          const response = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product);
          result = await response.json();
          break;
        }
        case 'closePosition': {
          if (product !== 'futures' || !symbol) {
            return res.status(400).json({ error: 'Symbol required for closing position' });
          }

          const posResponse = await callBinanceApi('/fapi/v2/positionRisk', apiKey, apiSecret, isTestnet, product);
          const positions = await posResponse.json();

          if (!Array.isArray(positions)) {
            return res.status(400).json({ error: 'Failed to fetch positions' });
          }

          const position = positions.find((p: { symbol: string }) => p.symbol === symbol);
          if (!position || parseFloat(position.positionAmt) === 0) {
            return res.json({ success: true, message: 'No position to close', realizedPnl: 0 });
          }

          const positionAmt = parseFloat(position.positionAmt);
          const unrealizedPnl = parseFloat(position.unRealizedProfit) || 0;
          const side = positionAmt > 0 ? 'SELL' : 'BUY';
          const quantity = Math.abs(positionAmt);

          const closeResponse = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, product, 'POST', {
            symbol,
            side,
            type: 'MARKET',
            quantity: quantity.toString(),
            reduceOnly: 'true',
          });
          const closeResult = await closeResponse.json();

          if (closeResponse.ok) {
            db.data?.trades.push({
              id: crypto.randomUUID(),
              user_id: req.user.id,
              exchange,
              environment,
              symbol,
              side: side.toLowerCase(),
              order_type: 'market',
              price: parseFloat(position.markPrice) || 0,
              quantity,
              realized_pnl: unrealizedPnl,
              status: 'filled',
              order_id: closeResult.orderId?.toString() || null,
              triggered_by: 'manual_close',
              created_at: new Date().toISOString(),
            });
            await safeWrite();

            result = { success: true, orderId: closeResult.orderId, realizedPnl: unrealizedPnl };
          } else {
            result = { success: false, error: closeResult.msg || 'Failed to close position' };
          }
          break;
        }
        default:
          return res.status(400).json({ error: 'Unknown action' });
      }
    } else if (exchange === 'bybit') {
      switch (action) {
        case 'getBalance': {
          const response = await callBybitApi('/v5/account/wallet-balance', apiKey, apiSecret, isTestnet, 'GET', {
            accountType: 'UNIFIED',
          });
          result = await response.json();
          break;
        }
        case 'getPositions': {
          const response = await callBybitApi('/v5/position/list', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            settleCoin: 'USDT',
          });
          result = await response.json();
          break;
        }
        case 'getOrders': {
          const response = await callBybitApi('/v5/order/history', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            limit: '100',
          });
          result = await response.json();
          break;
        }
        case 'getTrades': {
          const response = await callBybitApi('/v5/execution/list', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            limit: '100',
          });
          result = await response.json();
          break;
        }
        case 'getAccountInfo': {
          const response = await callBybitApi('/v5/account/info', apiKey, apiSecret, isTestnet);
          result = await response.json();
          break;
        }
        case 'closePosition': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for closing position' });
          }

          const posResponse = await callBybitApi('/v5/position/list', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'linear',
            symbol,
          });
          const posData = await posResponse.json();
          const position = posData.result?.list?.[0];

          if (!position || parseFloat(position.size) === 0) {
            return res.json({ success: true, message: 'No position to close', realizedPnl: 0 });
          }

          const unrealizedPnl = parseFloat(position.unrealisedPnl) || 0;
          const side = position.side === 'Buy' ? 'Sell' : 'Buy';

          const closeResponse = await callBybitApi('/v5/order/create', apiKey, apiSecret, isTestnet, 'POST', {
            category: 'linear',
            symbol,
            side,
            orderType: 'Market',
            qty: position.size,
            reduceOnly: 'true',
          });
          const closeResult = await closeResponse.json();

          if (closeResult.retCode === 0) {
            db.data?.trades.push({
              id: crypto.randomUUID(),
              user_id: req.user.id,
              exchange,
              environment,
              symbol,
              side: side.toLowerCase(),
              order_type: 'market',
              price: parseFloat(position.markPrice) || 0,
              quantity: parseFloat(position.size),
              realized_pnl: unrealizedPnl,
              status: 'filled',
              order_id: closeResult.result?.orderId || null,
              triggered_by: 'manual_close',
              created_at: new Date().toISOString(),
            });
            await safeWrite();

            result = { success: true, orderId: closeResult.result?.orderId, realizedPnl: unrealizedPnl };
          } else {
            result = { success: false, error: closeResult.retMsg || 'Failed to close position' };
          }
          break;
        }
        default:
          return res.status(400).json({ error: 'Unknown action' });
      }
    } else {
      return res.status(400).json({ error: 'Unknown exchange' });
    }

    return res.json({ success: true, data: result });
  } catch (error) {
    console.error('Exchange API error:', error);
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return res.status(500).json({ error: errorMessage });
  }
});

export const exchangeApiRouter = router;

