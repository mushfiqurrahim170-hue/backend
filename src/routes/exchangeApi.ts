import { Router } from 'express';
import { createHmac } from 'node:crypto';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { pool } from '../db/postgres.js';
import { encryptApiKey, decryptApiKey } from '../lib/encryption.js';
import { validateApiKeySave } from '../middleware/validation.js';

const router = Router();

interface ApiKeyData {
  api_key_encrypted: string;
  api_secret_encrypted: string;
  exchange: string;
  product: string;
  environment: string;
}

const getBaseAssetFromSymbol = (symbol: string): string => {
  const quoteAssets = ['USDT', 'USDC', 'BUSD', 'FDUSD', 'BTC', 'ETH'];
  const quote = quoteAssets.find((asset) => symbol.endsWith(asset));
  if (!quote) return symbol;
  return symbol.slice(0, symbol.length - quote.length);
};

const formatQty = (value: number) => {
  if (!Number.isFinite(value) || value <= 0) return null;
  return value.toFixed(8).replace(/\.?0+$/, '');
};

// Old decrypt function replaced by encryptApiKey/decryptApiKey
// Keeping for backward compatibility during migration
const decryptValue = (encrypted: string): string => {
  try {
    // Try new encryption format first (iv:encrypted)
    if (encrypted.includes(':')) {
      return decryptApiKey(encrypted);
    }
    // Fallback to old base64 format for backward compatibility
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

const cancelBinanceSpotSellOrders = async (
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  symbol: string
): Promise<void> => {
  const openOrdersResponse = await callBinanceApi('/api/v3/openOrders', apiKey, apiSecret, isTestnet, 'spot', 'GET', { symbol });
  const openOrders = await openOrdersResponse.json() as Array<{ orderId: number; orderListId?: number; side?: string }>;
  if (!openOrdersResponse.ok || !Array.isArray(openOrders)) return;

  const sellOrders = openOrders.filter((o) => (o.side || '').toUpperCase() === 'SELL');
  const ocoListIds = new Set<number>();
  const standaloneOrderIds: number[] = [];
  for (const order of sellOrders) {
    if (order.orderListId && order.orderListId > 0) {
      ocoListIds.add(order.orderListId);
    } else {
      standaloneOrderIds.push(order.orderId);
    }
  }

  for (const orderListId of ocoListIds) {
    await callBinanceApi('/api/v3/orderList', apiKey, apiSecret, isTestnet, 'spot', 'DELETE', {
      symbol,
      orderListId: String(orderListId),
    });
  }

  for (const orderId of standaloneOrderIds) {
    await callBinanceApi('/api/v3/order', apiKey, apiSecret, isTestnet, 'spot', 'DELETE', {
      symbol,
      orderId: String(orderId),
    });
  }
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

    // Validate required fields
    if (!action || !exchange || !product || !environment) {
      console.error('[exchange-api] Missing required fields:', { action, exchange, product, environment, body: req.body });
      return res.status(400).json({ 
        error: 'Missing required fields',
        required: ['action', 'exchange', 'product', 'environment'],
        received: { action, exchange, product, environment }
      });
    }

    // Ensure req.user exists (should be guaranteed by requireAuth, but TypeScript needs this)
    if (!req.user) {
      return res.status(401).json({ code: 401, message: 'Unauthorized' });
    }

    // At this point, req.user is guaranteed to exist due to the check above
    const userId = req.user.id;

    // Get API keys from PostgreSQL
    const apiKeyResult = await pool.query(
      `SELECT api_key_encrypted, api_secret_encrypted, exchange, product, environment 
       FROM api_keys 
       WHERE user_id = $1 AND exchange = $2 AND product = $3 AND environment = $4 AND is_active = true`,
      [userId, exchange, product, environment]
    );

    const apiKeyData = apiKeyResult.rows[0] as ApiKeyData | undefined;

    if (!apiKeyData) {
      // Get all keys for logging
      const allKeysResult = await pool.query(
        'SELECT exchange, product, environment, is_active FROM api_keys WHERE user_id = $1',
        [userId]
      );
      
      console.error('[exchange-api] API keys not found:', { 
        user_id: userId, 
        exchange, 
        product, 
        environment,
        available_keys: allKeysResult.rows.map(k => ({
          exchange: k.exchange,
          product: k.product,
          environment: k.environment,
          is_active: k.is_active
        }))
      });
      return res.status(400).json({ 
        error: 'API keys not configured',
        message: `No active API key found for ${exchange} ${product} ${environment}`,
        user_id: userId
      });
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
            // Debug logging
            console.log(`[getPositions] Binance Futures - User: ${userId}, Exchange: ${exchange}, Product: ${product}, Environment: ${environment}`);
            if (Array.isArray(result)) {
              console.log(`[getPositions] Response type: Array, Length: ${result.length}`);
              if (result.length > 0 && result[0] && typeof result[0] === 'object' && 'symbol' in result[0]) {
                const firstPos = result[0] as { symbol?: string; positionAmt?: string };
                console.log(`[getPositions] Sample position:`, {
                  symbol: firstPos.symbol,
                  positionAmt: firstPos.positionAmt,
                  isZero: parseFloat(firstPos.positionAmt || '0') === 0,
                });
              }
            } else {
              console.log(`[getPositions] Response type: ${typeof result}`);
            }
          } else {
            // Spot "open positions" are tracked in app DB from executed bot trades.
            const allPositionsResult = await pool.query(
              `SELECT * FROM positions 
               WHERE user_id = $1 AND exchange = $2 AND environment = $3 
               AND COALESCE(product, 'spot') = 'spot' AND is_open = true`,
              [userId, exchange, environment]
            );
            result = allPositionsResult.rows;
            // Debug logging
            console.log(`[getPositions] Binance Spot - User: ${userId}, Exchange: ${exchange}, Product: ${product}, Environment: ${environment}`);
            console.log(`[getPositions] Total positions in DB: ${allPositionsResult.rows.length}, Filtered (open): ${Array.isArray(result) ? result.length : 0}`);
            if (Array.isArray(result) && result.length > 0 && result[0]) {
              const firstPos = result[0] as { symbol?: string; size?: number | string; is_open?: boolean };
              console.log(`[getPositions] Sample position:`, {
                symbol: firstPos.symbol,
                size: firstPos.size,
                is_open: firstPos.is_open,
              });
            }
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
            // Binance spot trade history endpoint requires symbol; use app DB history for UI.
            const tradesResult = await pool.query(
              `SELECT * FROM trades 
               WHERE user_id = $1 AND exchange = $2 AND environment = $3 
               AND COALESCE(product, 'spot') = 'spot'
               ORDER BY created_at DESC 
               LIMIT 100`,
              [userId, exchange, environment]
            );
            result = tradesResult.rows;
          }
          break;
        }
        case 'getAccountInfo': {
          const endpoint = product === 'futures' ? '/fapi/v2/account' : '/api/v3/account';
          const response = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product);
          result = await response.json();
          break;
        }
        case 'getPrice': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for getPrice' });
          }
          const endpoint = product === 'futures' ? '/fapi/v1/ticker/price' : '/api/v3/ticker/price';
          const response = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product, 'GET', { symbol });
          result = await response.json();
          break;
        }
        case 'closePosition': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for closing position' });
          }

          if (product === 'futures') {
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
            const closeResult = await closeResponse.json() as {
              msg?: string;
              orderId?: number;
            };

            if (closeResponse.ok) {
              // Insert trade record into PostgreSQL
              await pool.query(
                `INSERT INTO trades (id, user_id, exchange, product, environment, symbol, side, order_type, price, quantity, realized_pnl, status, order_id, triggered_by, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [crypto.randomUUID(), userId, exchange, product, environment, symbol, side.toLowerCase(), 'market', 
                 parseFloat(position.markPrice) || 0, quantity, unrealizedPnl, 'filled', 
                 closeResult.orderId?.toString() || null, 'manual_close', new Date().toISOString()]
              );

              result = { success: true, orderId: closeResult.orderId, realizedPnl: unrealizedPnl };
            } else {
              result = { success: false, error: closeResult.msg || 'Failed to close position' };
            }
          } else {
            // Spot close: cancel existing sell/OCO orders, then market-sell available base quantity.
            await cancelBinanceSpotSellOrders(apiKey, apiSecret, isTestnet, symbol);

            const accountResponse = await callBinanceApi('/api/v3/account', apiKey, apiSecret, isTestnet, product, 'GET');
            const accountData = await accountResponse.json() as { balances?: Array<{ asset: string; free: string }> };
            if (!accountResponse.ok) {
              result = { success: false, error: (accountData as { msg?: string }).msg || 'Failed to fetch spot account' };
              break;
            }

            const baseAsset = getBaseAssetFromSymbol(symbol);
            const availableBase = parseFloat(accountData.balances?.find((b) => b.asset === baseAsset)?.free || '0');

            // Get open position from PostgreSQL
            const dbOpenPositionResult = await pool.query(
              `SELECT * FROM positions 
               WHERE user_id = $1 AND exchange = $2 AND environment = $3 
               AND COALESCE(product, 'spot') = 'spot' AND symbol = $4 AND is_open = true
               ORDER BY created_at DESC LIMIT 1`,
              [userId, exchange, environment, symbol]
            );
            const dbOpenPosition = dbOpenPositionResult.rows[0];

            const targetSize = Math.abs(Number(dbOpenPosition?.size || 0));
            const qtyToSell = Math.min(availableBase, targetSize || availableBase);
            const qtyStr = formatQty(qtyToSell);

            if (!qtyStr || qtyToSell <= 0) {
              if (dbOpenPosition) {
                await pool.query(
                  `UPDATE positions SET is_open = false, updated_at = $1 WHERE id = $2`,
                  [new Date().toISOString(), dbOpenPosition.id]
                );
              }
              result = { success: true, message: 'No spot quantity available to close', realizedPnl: 0 };
              break;
            }

            const closeResponse = await callBinanceApi('/api/v3/order', apiKey, apiSecret, isTestnet, product, 'POST', {
              symbol,
              side: 'SELL',
              type: 'MARKET',
              quantity: qtyStr,
            });
            const closeResult = await closeResponse.json() as {
              msg?: string;
              orderId?: number;
              cummulativeQuoteQty?: string;
              executedQty?: string;
              fills?: Array<{ price: string; qty: string }>;
            };

            if (closeResponse.ok) {
              const executedQty = parseFloat(closeResult.executedQty || qtyStr) || qtyToSell;
              const avgExitPrice = (() => {
                const fromQuote = parseFloat(closeResult.cummulativeQuoteQty || '0');
                if (executedQty > 0 && fromQuote > 0) return fromQuote / executedQty;
                if (Array.isArray(closeResult.fills) && closeResult.fills.length > 0) {
                  const totalQty = closeResult.fills.reduce((s, f) => s + (parseFloat(f.qty) || 0), 0);
                  const totalQuote = closeResult.fills.reduce((s, f) => s + (parseFloat(f.qty) || 0) * (parseFloat(f.price) || 0), 0);
                  if (totalQty > 0) return totalQuote / totalQty;
                }
                return Number(dbOpenPosition?.current_price || dbOpenPosition?.entry_price || 0);
              })();
              const entryPrice = Number(dbOpenPosition?.entry_price || 0);
              const realizedPnl = entryPrice > 0 ? (avgExitPrice - entryPrice) * executedQty : 0;

              // Close matching app positions for this symbol/user context.
              await pool.query(
                `UPDATE positions 
                 SET is_open = false, current_price = $1, unrealized_pnl = $2, updated_at = $3
                 WHERE user_id = $4 AND exchange = $5 AND environment = $6 
                 AND COALESCE(product, 'spot') = 'spot' AND symbol = $7 AND is_open = true`,
                [avgExitPrice, realizedPnl, new Date().toISOString(), userId, exchange, environment, symbol]
              );

              // Insert trade record
              await pool.query(
                `INSERT INTO trades (id, user_id, exchange, product, environment, symbol, side, order_type, price, quantity, realized_pnl, status, order_id, triggered_by, created_at)
                 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
                [crypto.randomUUID(), userId, exchange, product, environment, symbol, 'sell', 'market',
                 avgExitPrice, executedQty, realizedPnl, 'filled',
                 closeResult.orderId?.toString() || null, 'manual_close', new Date().toISOString()]
              );

              result = { success: true, orderId: closeResult.orderId, realizedPnl };
            } else {
              result = { success: false, error: closeResult.msg || 'Failed to close spot position' };
            }
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
        case 'getPrice': {
          if (!symbol) {
            return res.status(400).json({ error: 'Symbol required for getPrice' });
          }
          const response = await callBybitApi('/v5/market/tickers', apiKey, apiSecret, isTestnet, 'GET', {
            category: 'spot',
            symbol,
          });
          const tickerData = await response.json();
          // Extract price from Bybit response
          if (tickerData.result?.list?.[0]?.lastPrice) {
            result = { price: tickerData.result.list[0].lastPrice };
          } else {
            result = { price: '0' };
          }
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
          const posData = await posResponse.json() as {
            retCode?: number;
            retMsg?: string;
            result?: {
              list?: Array<{
                size?: string;
                side?: string;
                unrealisedPnl?: string;
                markPrice?: string;
              }>;
            };
          };
          const position = posData.result?.list?.[0];

          if (!position || !position.size || parseFloat(position.size) === 0) {
            return res.json({ success: true, message: 'No position to close', realizedPnl: 0 });
          }

          const unrealizedPnl = parseFloat(position.unrealisedPnl || '0') || 0;
          const side = position.side === 'Buy' ? 'Sell' : 'Buy';

          const closeResponse = await callBybitApi('/v5/order/create', apiKey, apiSecret, isTestnet, 'POST', {
            category: 'linear',
            symbol,
            side,
            orderType: 'Market',
            qty: position.size || '0',
            reduceOnly: 'true',
          });
          const closeResult = await closeResponse.json() as {
            retCode?: number;
            retMsg?: string;
            result?: {
              orderId?: string;
            };
          };

          if (closeResult.retCode === 0) {
            // Insert trade record into PostgreSQL
            await pool.query(
              `INSERT INTO trades (id, user_id, exchange, product, environment, symbol, side, order_type, price, quantity, realized_pnl, status, order_id, triggered_by, created_at)
               VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15)`,
              [crypto.randomUUID(), userId, exchange, product, environment, symbol, side.toLowerCase(), 'market',
               parseFloat(position.markPrice || '0') || 0, parseFloat(position.size), unrealizedPnl, 'filled',
               closeResult.result?.orderId || null, 'manual_close', new Date().toISOString()]
            );

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

