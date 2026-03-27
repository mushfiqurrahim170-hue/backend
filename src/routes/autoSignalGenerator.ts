import { Router } from 'express';
import crypto from 'node:crypto';
import { fetch } from 'undici';
import { db, safeWrite, type TradingStrategy, type ApiKey, type BotStatus, type GasFeeBalance, type Position, type Trade, type WebhookLog } from '../db/index.js';
import { fetchKlines } from '../lib/marketData.js';
import { analyzeSignal, type StrategyIndicators } from '../lib/signalAnalysis.js';
import { createHmac } from 'node:crypto';

const router = Router();
const MIN_SIGNAL_CONFIDENCE = 0.70; // Minimum 70% confidence for signal generation
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-1.5-flash';

const isPrecisionError = (message?: string) => {
  if (!message) return false;
  return /precision|step|lot|qty|quantity|filter failure/i.test(message);
};

const formatQty = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  const floored = Math.floor(value * factor) / factor;
  if (!Number.isFinite(floored) || floored <= 0) return null;
  return floored.toFixed(decimals).replace(/\.?0+$/, '');
};

const clampNumber = (value: number, min: number, max: number) => {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
};

const getConfigNumber = (config: Record<string, unknown>, key: string, fallback: number) => {
  const value = config[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
};

const getConfigBoolean = (config: Record<string, unknown>, key: string, fallback: boolean) => {
  const value = config[key];
  return typeof value === 'boolean' ? value : fallback;
};

const isWithinTradingSession = (config: Record<string, unknown>, now = new Date()) => {
  const start = typeof config.session_start === 'string' ? config.session_start : null;
  const end = typeof config.session_end === 'string' ? config.session_end : null;
  if (!start || !end) return true;

  const [startH, startM] = start.split(':').map((s) => Number(s));
  const [endH, endM] = end.split(':').map((s) => Number(s));
  if (![startH, startM, endH, endM].every((n) => Number.isFinite(n))) return true;

  const minutesNow = now.getUTCHours() * 60 + now.getUTCMinutes();
  const startMinutes = startH * 60 + startM;
  const endMinutes = endH * 60 + endM;

  if (startMinutes <= endMinutes) {
    return minutesNow >= startMinutes && minutesNow <= endMinutes;
  }
  // Overnight session (e.g. 22:00-06:00)
  return minutesNow >= startMinutes || minutesNow <= endMinutes;
};

const getBookTicker = async (
  exchange: string,
  product: string,
  symbol: string,
  isTestnet: boolean
): Promise<{ bid: number; ask: number } | null> => {
  try {
    if (exchange === 'binance') {
      const isFutures = product === 'futures';
      const baseUrl = isFutures
        ? isTestnet
          ? 'https://testnet.binancefuture.com'
          : 'https://fapi.binance.com'
        : isTestnet
          ? 'https://testnet.binance.vision'
          : 'https://api.binance.com';
      const endpoint = isFutures ? '/fapi/v1/ticker/bookTicker' : '/api/v3/ticker/bookTicker';
      const url = `${baseUrl}${endpoint}?symbol=${symbol}`;
      const response = await fetch(url);
      const data = await response.json() as { bidPrice?: string; askPrice?: string };
      const bid = parseFloat(data.bidPrice || '0');
      const ask = parseFloat(data.askPrice || '0');
      if (bid > 0 && ask > 0) return { bid, ask };
      return null;
    }

    if (exchange === 'bybit') {
      const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';
      const url = `${baseUrl}/v5/market/orderbook?category=linear&symbol=${symbol}&limit=1`;
      const response = await fetch(url);
      const data = await response.json() as { result?: { b?: Array<[string, string]>; a?: Array<[string, string]> } };
      const bid = parseFloat(data.result?.b?.[0]?.[0] || '0');
      const ask = parseFloat(data.result?.a?.[0]?.[0] || '0');
      if (bid > 0 && ask > 0) return { bid, ask };
      return null;
    }
  } catch {
    return null;
  }

  return null;
};

const getAccountBalance = async (
  exchange: string,
  product: string,
  environment: string,
  apiKey: string,
  apiSecret: string
): Promise<{ available: number; total: number }> => {
  const isTestnet = environment === 'testnet';

  if (exchange === 'binance') {
    const endpoint = product === 'futures' ? '/fapi/v2/balance' : '/api/v3/account';
    const result = await callBinanceApi(endpoint, apiKey, apiSecret, isTestnet, product);
    if (result.success && result.data) {
      if (product === 'futures') {
        const balances = result.data as Array<{ asset: string; availableBalance: string; balance: string }>;
        const usdtBalance = balances.find((b) => b.asset === 'USDT');
        if (usdtBalance) {
          return {
            available: parseFloat(usdtBalance.availableBalance) || 0,
            total: parseFloat(usdtBalance.balance) || 0,
          };
        }
      }
    }
    return { available: 0, total: 0 };
  }

  if (exchange === 'bybit') {
    const result = await callBybitApi(
      '/v5/account/wallet-balance',
      apiKey,
      apiSecret,
      isTestnet,
      'GET',
      { accountType: 'UNIFIED' }
    );
    if (result.success && result.data) {
      type BybitBalanceResponse = {
        result?: { list?: Array<{ coin?: Array<{ coin: string; equity: string; availableToWithdraw?: string }> }> };
      };
      const balanceResponse = result.data as BybitBalanceResponse;
      const coins = balanceResponse.result?.list?.[0]?.coin;
      if (coins) {
        const usdtBalance = coins.find((c) => c.coin === 'USDT');
        if (usdtBalance) {
          const total = parseFloat(usdtBalance.equity) || 0;
          const available = parseFloat(usdtBalance.availableToWithdraw || usdtBalance.equity) || 0;
          return { available, total };
        }
      }
    }
    return { available: 0, total: 0 };
  }

  return { available: 0, total: 0 };
};

interface StrategyConfig extends TradingStrategy {
  exchange: string;
  product: string;
  environment: string;
  allowed_pairs: string[];
  auto_signal_indicators: StrategyIndicators;
  auto_signal_interval: number;
  last_signal_at: string | null;
  position_size_type: string;
  position_size_value: number;
  default_leverage: number;
  tp1_percent: number;
  tp2_percent: number;
  tp3_percent: number;
  stop_loss_percent: number;
  use_tp1: boolean;
  use_tp2: boolean;
  use_tp3: boolean;
  max_positions: number;
  tp1_close_percent: number;
  tp2_close_percent: number;
  tp3_close_percent: number;
  signal_mode?: string;
  auto_signal_enabled?: boolean;
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

type GeminiDecision = {
  ok: boolean;
  execute: boolean;
  confidence: number;
  reason?: string;
  raw?: string;
};

const extractJsonFromText = (text: string): string | null => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) {
    return null;
  }
  return text.slice(start, end + 1);
};

const getGeminiFilterDecision = async (
  signal: { action: string; symbol: string; price: number; confidence: number; indicators: unknown; rsi_value?: number },
  indicators: StrategyIndicators
): Promise<GeminiDecision> => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return { ok: false, execute: false, confidence: 0, reason: 'missing_gemini_api_key' };
  }

  const prompt = [
    'You are a trading signal filter.',
    'Return JSON only in the format: {"execute":true|false,"confidence":0-1,"reason":"..."}',
    'Use 0-1 confidence where 0.8-1.0 means high confidence.',
    `Action: ${signal.action}`,
    `Symbol: ${signal.symbol}`,
    `Price: ${signal.price}`,
    `Engine confidence: ${signal.confidence}`,
    `RSI: ${signal.rsi_value ?? 'n/a'}`,
    `Indicators: ${JSON.stringify(signal.indicators)}`,
    `Config: ${JSON.stringify(indicators)}`,
    'If the signal looks weak or conflicting, set execute=false.',
  ].join('\n');

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.2, maxOutputTokens: 200 },
        }),
      }
    );

    if (!response.ok) {
      return { ok: false, execute: false, confidence: 0, reason: `gemini_http_${response.status}` };
    }

    const data = await response.json() as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
    };
    const text =
      data.candidates?.[0]?.content?.parts?.map((part) => part.text || '').join('')?.trim() || '';
    const jsonText = extractJsonFromText(text);

    if (!jsonText) {
      return { ok: false, execute: false, confidence: 0, reason: 'gemini_invalid_json', raw: text };
    }

    const parsed = JSON.parse(jsonText) as { execute?: boolean; confidence?: number; reason?: string };
    const execute = Boolean(parsed.execute);
    const confidence = typeof parsed.confidence === 'number' ? parsed.confidence : 0;

    return {
      ok: true,
      execute,
      confidence,
      reason: parsed.reason || 'gemini_filter',
      raw: jsonText,
    };
  } catch (error) {
    return { ok: false, execute: false, confidence: 0, reason: (error as Error).message };
  }
};

const callBinanceApi = async (
  endpoint: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  product: string,
  method = 'GET',
  params: Record<string, string> = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> => {
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
  
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'X-MBX-APIKEY': apiKey,
        'Content-Type': 'application/json',
      },
    });
    const data = await response.json();
    
    if (!response.ok) {
      return { success: false, error: (data as { msg?: string }).msg || 'Binance API error' };
    }
    return { success: true, data };
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Network error' };
  }
};

const createBybitSignature = (
  timestamp: string,
  apiKey: string,
  recvWindow: string,
  payload: string,
  secret: string
): string => {
  const signStr = timestamp + apiKey + recvWindow + payload;
  const hmac = createHmac('sha256', secret);
  hmac.update(signStr);
  return hmac.digest('hex');
};

const callBybitApi = async (
  endpoint: string,
  apiKey: string,
  apiSecret: string,
  isTestnet: boolean,
  method = 'GET',
  params: Record<string, unknown> = {}
): Promise<{ success: boolean; data?: unknown; error?: string }> => {
  const baseUrl = isTestnet ? 'https://api-testnet.bybit.com' : 'https://api.bybit.com';

  const timestamp = Date.now().toString();
  const recvWindow = '5000';
  
  let url = `${baseUrl}${endpoint}`;
  let body = '';
  
  if (method === 'GET') {
    const queryString = new URLSearchParams(params as Record<string, string>).toString();
    if (queryString) url += '?' + queryString;
    const signature = createBybitSignature(timestamp, apiKey, recvWindow, queryString, apiSecret);
    
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
        },
      });
      const data = await response.json() as { retCode?: number; retMsg?: string };
      if (data.retCode !== 0) {
        return { success: false, error: data.retMsg || 'Bybit API error' };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  } else {
    body = JSON.stringify(params);
    const signature = createBybitSignature(timestamp, apiKey, recvWindow, body, apiSecret);
    
    try {
      const response = await fetch(url, {
        method,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'X-BAPI-SIGN': signature,
          'Content-Type': 'application/json',
        },
        body,
      });
      const data = await response.json() as { retCode?: number; retMsg?: string };
      if (data.retCode !== 0) {
        return { success: false, error: data.retMsg || 'Bybit API error' };
      }
      return { success: true, data };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Network error' };
    }
  }
};

interface AutoSignalResult {
  strategy: string;
  pair: string;
  signal: { action: string; symbol: string; price: number; confidence: number } | null;
  executed: boolean;
  tradeId?: string;
  reason?: string;
}

router.post('/', async (_req, res) => {
  try {
    await db.read();
    if (!db.data) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    // Ensure required tables exist
    db.data.trades ||= [];
    db.data.positions ||= [];
    db.data.webhook_logs ||= [];
    db.data.trading_strategies ||= [];
    db.data.api_keys ||= [];
    db.data.bot_status ||= [];
    db.data.gas_fee_balances ||= [];
    
    // Get all active auto-signal strategies
    const strategies = (db.data.trading_strategies || [])
      .filter(
        (s) =>
          s.is_active &&
          ((s as StrategyConfig).signal_mode === 'auto' || !(s as StrategyConfig).signal_mode) &&
          ((s as StrategyConfig).auto_signal_enabled === true || !(s as StrategyConfig).auto_signal_enabled)
      )
      .map((s) => {
        const strategy = s as StrategyConfig;
        // Ensure auto_signal_indicators exists with defaults
        if (!strategy.auto_signal_indicators) {
          strategy.auto_signal_indicators = {
            ema_short: 12,
            ema_long: 26,
            rsi_period: 14,
            rsi_overbought: 70,
            rsi_oversold: 30,
            macd_fast: 12,
            macd_slow: 26,
            macd_signal: 9,
            volume_multiplier: 1.5,
          };
        }
        // Ensure other required fields have defaults
        if (!strategy.allowed_pairs || !Array.isArray(strategy.allowed_pairs) || strategy.allowed_pairs.length === 0) {
          strategy.allowed_pairs = ['BTCUSDT', 'ETHUSDT'];
        }
        if (!strategy.max_positions) {
          strategy.max_positions = 5;
        }
        if (!strategy.default_leverage) {
          strategy.default_leverage = 1;
        }
        if (!strategy.stop_loss_percent) {
          strategy.stop_loss_percent = 2;
        }
        if (!strategy.tp1_percent) {
          strategy.tp1_percent = 3;
        }
        if (strategy.use_tp1 === undefined) {
          strategy.use_tp1 = true;
        }
        if (!strategy.tp1_close_percent) {
          strategy.tp1_close_percent = 50;
        }
        if (!strategy.auto_signal_interval) {
          strategy.auto_signal_interval = 1;
        }
        return strategy;
      }) as StrategyConfig[];

    if (strategies.length === 0) {
      return res.json({
        processed: 0,
        results: [],
        summary: {
          executed: 0,
          totalSignals: 0,
          timestamp: new Date().toISOString(),
        },
        message: 'No active auto-signal strategies found',
      });
    }

    const results: AutoSignalResult[] = [];

    for (const config of strategies) {
      const strategyConfig = (config.strategy_config as Record<string, unknown>) || {};
      const minConfidence = clampNumber(
        getConfigNumber(strategyConfig, 'min_confidence', MIN_SIGNAL_CONFIDENCE),
        0,
        1
      );
      const maxSpreadPercent = getConfigNumber(strategyConfig, 'max_spread_percent', 0);
      const maxSlippagePercent = getConfigNumber(strategyConfig, 'max_slippage_percent', 0);
      const requireVolumeConfirmed = getConfigBoolean(strategyConfig, 'require_volume_confirmed', false);
      const riskPercent = getConfigNumber(strategyConfig, 'risk_percent', 0);
      const cooldownMinutes = getConfigNumber(strategyConfig, 'cooldown_minutes', 0);
      const now = new Date();

      if (!isWithinTradingSession(strategyConfig, now)) {
        console.log(`Outside trading session for strategy ${config.id}`);
        continue;
      }

      const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
      const trades = db.data.trades || [];
      const dailyTrades = trades.filter(
        (t) =>
          t.user_id === config.user_id &&
          t.triggered_by === 'auto_strategy' &&
          new Date(t.created_at) >= dayStart
      );
      const maxTradesPerDay = getConfigNumber(strategyConfig, 'max_trades_per_day', 0);
      if (maxTradesPerDay > 0 && dailyTrades.length >= maxTradesPerDay) {
        console.log(`Max trades per day reached for strategy ${config.id}`);
        continue;
      }

      const dailyPnl = trades
        .filter((t) => t.user_id === config.user_id && new Date(t.created_at) >= dayStart)
        .reduce((sum, t) => sum + Number(t.realized_pnl || 0), 0);
      const maxDailyLoss = getConfigNumber(strategyConfig, 'max_daily_loss', 0);
      if (maxDailyLoss > 0 && dailyPnl <= -maxDailyLoss) {
        console.log(`Max daily loss reached for strategy ${config.id}`);
        continue;
      }

      const maxConsecutiveLosses = getConfigNumber(strategyConfig, 'max_consecutive_losses', 0);
      if (maxConsecutiveLosses > 0) {
        const recent = trades
          .filter((t) => t.user_id === config.user_id && t.realized_pnl !== undefined)
          .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());
        let consecutiveLosses = 0;
        let lastLossAt: Date | null = null;
        for (const trade of recent) {
          if ((trade.realized_pnl || 0) < 0) {
            consecutiveLosses += 1;
            if (!lastLossAt) lastLossAt = new Date(trade.created_at);
          } else if ((trade.realized_pnl || 0) > 0) {
            break;
          }
        }

        if (consecutiveLosses >= maxConsecutiveLosses) {
          if (cooldownMinutes > 0 && lastLossAt) {
            const minutesSinceLoss = (Date.now() - lastLossAt.getTime()) / 60000;
            if (minutesSinceLoss < cooldownMinutes) {
              console.log(`Cooldown active for strategy ${config.id} after loss streak`);
              continue;
            }
          } else {
            console.log(`Max consecutive losses reached for strategy ${config.id}`);
            continue;
          }
        }
      }
      const pairs = config.allowed_pairs || ['BTCUSDT', 'ETHUSDT'];
      const isTestnet = config.environment === 'testnet';

      // Check if enough time has passed since last signal
      const intervalMinutes = config.auto_signal_interval || 1;
      if (config.last_signal_at) {
        const lastSignalTime = new Date(config.last_signal_at).getTime();
        const now = Date.now();
        const minutesSinceLastSignal = (now - lastSignalTime) / (1000 * 60);

        if (minutesSinceLastSignal < intervalMinutes) {
          const remainingSeconds = Math.ceil((intervalMinutes - minutesSinceLastSignal) * 60);
          console.log(
            `⏳ Strategy ${config.name}: Waiting ${remainingSeconds}s before next signal (interval: ${intervalMinutes}min)`
          );
          continue;
        }
      }

      // Get user's API keys
      const apiKeys = (db.data?.api_keys || []).find(
        (k) =>
          k.user_id === config.user_id &&
          k.exchange === config.exchange &&
          k.product === config.product &&
          k.environment === config.environment &&
          k.is_active
      ) as ApiKey | undefined;

      if (!apiKeys) {
        console.log(`No API keys found for strategy ${config.id}`);
        continue;
      }

      const apiKey = decryptValue(apiKeys.api_key_encrypted);
      const apiSecret = decryptValue(apiKeys.api_secret_encrypted);

      // Check if bot is running
      const botStatus = (db.data?.bot_status || []).find(
        (b) =>
          b.user_id === config.user_id &&
          b.environment === config.environment &&
          (b.exchange === config.exchange || !b.exchange)
      ) as BotStatus | undefined;

      if (!botStatus?.is_running) {
        console.log(`Bot is not running for strategy ${config.id} - skipping signal generation`);
        continue;
      }

      // Check gas fee balance
      const gasBalance = (db.data?.gas_fee_balances || []).find(
        (b) => b.user_id === config.user_id && b.environment === config.environment
      ) as GasFeeBalance | undefined;

      if (!gasBalance || gasBalance.balance <= 0) {
        console.log(`Insufficient gas balance for strategy ${config.id}`);
        continue;
      }

      // Check current positions count
      const positionCount = (db.data?.positions || []).filter(
        (p) => p.user_id === config.user_id && p.is_open
      ).length;

      if (positionCount >= config.max_positions) {
        console.log(`Max positions reached for strategy ${config.id}`);
        continue;
      }

      for (const pair of pairs) {
        try {
          // Fetch klines
          const interval = config.exchange === 'binance' ? '1m' : '1';
          const candles = await fetchKlines(config.exchange, pair, interval, isTestnet, config.product, 100);

          if (candles.length < 50) {
            console.log(`Insufficient candle data for ${pair} (got ${candles.length} candles, need 50+)`);
            continue;
          }

          // Analyze signal
          if (!config.auto_signal_indicators) {
            console.log(`Strategy ${config.id} missing auto_signal_indicators, skipping ${pair}`);
            continue;
          }
          const signal = analyzeSignal(candles, config.auto_signal_indicators, pair);

          if (signal.action === 'none') {
            continue;
          }

          if (requireVolumeConfirmed && !signal.indicators.volume_confirmed) {
            console.log(`Volume not confirmed for ${pair}, skipping`);
            continue;
          }

          if (maxSpreadPercent > 0 || maxSlippagePercent > 0) {
            const book = await getBookTicker(config.exchange, config.product, pair, isTestnet);
            if (book) {
              const mid = (book.bid + book.ask) / 2;
              const spreadPct = ((book.ask - book.bid) / mid) * 100;
              const slippagePct = Math.abs(signal.price - mid) / mid * 100;
              if (maxSpreadPercent > 0 && spreadPct > maxSpreadPercent) {
                console.log(`Spread too high for ${pair}: ${spreadPct.toFixed(3)}%`);
                continue;
              }
              if (maxSlippagePercent > 0 && slippagePct > maxSlippagePercent) {
                console.log(`Slippage too high for ${pair}: ${slippagePct.toFixed(3)}%`);
                continue;
              }
            }
          }

          const engineConfidenceOk = signal.confidence >= minConfidence;
          let shouldExecute = false;
          let skipReason = '';
          let geminiDecision: GeminiDecision | null = null;

          if (!engineConfidenceOk) {
            skipReason = 'Confidence below threshold';
          } else {
            const decision = await getGeminiFilterDecision(signal, config.auto_signal_indicators);
            if (decision.ok) {
              geminiDecision = decision;
              if (decision.execute && decision.confidence >= minConfidence) {
                shouldExecute = true;
              } else {
                skipReason = decision.reason || 'Gemini rejected signal';
              }
            } else {
              // Gemini unavailable -> fallback to engine signal
              shouldExecute = true;
              skipReason = `Gemini unavailable: ${decision.reason || 'unknown_error'}`;
            }
          }

          // Only execute if signal confidence >= 0.80 (80%) and Gemini filter passes (or Gemini fails)
          if (shouldExecute) {
            const leverage = config.default_leverage;
            const price = signal.price;

            // Calculate position size (balance-aware)
            let quantity = 0.001;
            if (riskPercent > 0 && config.stop_loss_percent > 0) {
              const { total: balance } = await getAccountBalance(
                config.exchange,
                config.product,
                config.environment,
                apiKey,
                apiSecret
              );
              const riskAmount = balance * (riskPercent / 100);
              const stopDistance = price * (config.stop_loss_percent / 100);
              quantity = stopDistance > 0 ? riskAmount / stopDistance : quantity;
            } else if (config.position_size_type === 'fixed') {
              quantity = config.position_size_value / price;
            } else {
              const { total: balance } = await getAccountBalance(
                config.exchange,
                config.product,
                config.environment,
                apiKey,
                apiSecret
              );
              const positionValue = balance * (config.position_size_value / 100);
              quantity = positionValue / price;
            }
            const roundedQty = Math.floor(quantity * 1000) / 1000;

            let orderId: string | undefined;
            let orderSuccess = false;
            let executionError: string | null = null;
            let orderQtyDecimals: number | null = null;

            if (config.exchange === 'binance' && config.product === 'futures') {
              const positionSide = (strategyConfig.position_side as string | undefined) || 'BOTH';
              // Set leverage
              const leverageResult = await callBinanceApi(
                '/fapi/v1/leverage',
                apiKey,
                apiSecret,
                isTestnet,
                config.product,
                'POST',
                {
                  symbol: pair,
                  leverage: leverage.toString(),
                }
              );
              if (!leverageResult.success) {
                executionError = leverageResult.error || 'Failed to set leverage';
              }

              // Place market order
              const side = signal.action === 'buy' ? 'BUY' : 'SELL';
              let orderResult: { success: boolean; data?: unknown; error?: string } = {
                success: false,
                error: executionError || 'Failed to set leverage',
              };
              if (!executionError) {
                const attempts = [3, 2, 1, 0];
                let lastError: string | undefined;
                for (const decimals of attempts) {
                  const qtyStr = formatQty(quantity, decimals);
                  if (!qtyStr) continue;
                  const attemptResult = await callBinanceApi(
                    '/fapi/v1/order',
                    apiKey,
                    apiSecret,
                    isTestnet,
                    config.product,
                    'POST',
                    {
                      symbol: pair,
                      side,
                      type: 'MARKET',
                      ...(positionSide !== 'BOTH' && { positionSide }),
                      quantity: qtyStr,
                    }
                  );
                  if (attemptResult.success) {
                    orderResult = attemptResult;
                    orderQtyDecimals = decimals;
                    break;
                  }
                  lastError = attemptResult.error;
                  if (!isPrecisionError(attemptResult.error)) {
                    orderResult = attemptResult;
                    break;
                  }
                }
                if (!orderResult.success && lastError) {
                  orderResult = { success: false, error: lastError };
                }
              }

              if (orderResult.success) {
                const orderData = orderResult.data as { orderId: number };
                orderId = orderData.orderId.toString();
                orderSuccess = true;

                // Place SL/TP orders
                const tpSlErrors: string[] = [];
                if (price > 0) {
                  const closeSide = side === 'BUY' ? 'SELL' : 'BUY';
                  const slPrice = side === 'BUY'
                    ? price * (1 - config.stop_loss_percent / 100)
                    : price * (1 + config.stop_loss_percent / 100);

                  const slResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, config.product, 'POST', {
                    symbol: pair,
                    side: closeSide,
                    type: 'STOP_MARKET',
                    stopPrice: slPrice.toFixed(2),
                    closePosition: 'true',
                    ...(positionSide !== 'BOTH' && { positionSide }),
                  });
                  if (!slResult.success) {
                    tpSlErrors.push(slResult.error || 'Stop loss failed');
                  }

                  const tpLevels = [
                    { enabled: config.use_tp1, percent: config.tp1_percent, closePercent: config.tp1_close_percent },
                    { enabled: config.use_tp2, percent: config.tp2_percent, closePercent: config.tp2_close_percent },
                    { enabled: config.use_tp3, percent: config.tp3_percent, closePercent: config.tp3_close_percent },
                  ];
                  const decimals = orderQtyDecimals ?? 3;

                  for (const tp of tpLevels) {
                    if (!tp.enabled) continue;
                    const tpPrice = side === 'BUY'
                      ? price * (1 + tp.percent / 100)
                      : price * (1 - tp.percent / 100);
                    const tpQty = Math.floor(roundedQty * (tp.closePercent / 100) * 1000) / 1000;
                    const tpQtyStr = formatQty(tpQty, decimals);

                    if (tpQtyStr) {
                      const tpResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, config.product, 'POST', {
                        symbol: pair,
                        side: closeSide,
                        type: 'TAKE_PROFIT_MARKET',
                        stopPrice: tpPrice.toFixed(2),
                        ...(positionSide !== 'BOTH' && { positionSide }),
                        quantity: tpQtyStr,
                      });
                      if (!tpResult.success) {
                        tpSlErrors.push(tpResult.error || `TP${tp.percent} failed`);
                      }
                    }
                  }

                  const useTrailingStop = getConfigBoolean(strategyConfig, 'use_trailing_stop', false);
                  const trailingStopCallback = getConfigNumber(strategyConfig, 'trailing_stop_callback', 0);
                  const trailingStopActivation = getConfigNumber(strategyConfig, 'trailing_stop_activation', 0);
                  if (useTrailingStop && trailingStopCallback > 0) {
                    const callbackRate = clampNumber(trailingStopCallback, 0.1, 5);
                    const activationPrice = trailingStopActivation > 0
                      ? side === 'BUY'
                        ? price * (1 + trailingStopActivation / 100)
                        : price * (1 - trailingStopActivation / 100)
                      : 0;
                    const params: Record<string, string> = {
                      symbol: pair,
                      side: closeSide,
                      type: 'TRAILING_STOP_MARKET',
                      callbackRate: callbackRate.toString(),
                    };
                    if (activationPrice > 0) {
                      params.activationPrice = activationPrice.toFixed(2);
                    }
                    if (positionSide !== 'BOTH') {
                      params.positionSide = positionSide;
                    }
                    const trailingResult = await callBinanceApi('/fapi/v1/order', apiKey, apiSecret, isTestnet, config.product, 'POST', params);
                    if (!trailingResult.success) {
                      tpSlErrors.push(trailingResult.error || 'Trailing stop failed');
                    }
                  }
                }
                if (tpSlErrors.length > 0) {
                  executionError = tpSlErrors.join(' | ');
                }
              }
              if (!orderResult.success) {
                executionError = orderResult.error || 'Binance order failed';
              }
            } else if (config.exchange === 'bybit') {
              const positionIdx = typeof strategyConfig.position_idx === 'number' ? strategyConfig.position_idx : 0;
              // Set leverage
              const leverageResult = await callBybitApi(
                '/v5/position/set-leverage',
                apiKey,
                apiSecret,
                isTestnet,
                'POST',
                {
                  category: 'linear',
                  symbol: pair,
                  buyLeverage: leverage.toString(),
                  sellLeverage: leverage.toString(),
                }
              );
              if (!leverageResult.success) {
                executionError = leverageResult.error || 'Failed to set leverage';
              }

              // Place market order
              const side = signal.action === 'buy' ? 'Buy' : 'Sell';
              let orderResult: { success: boolean; data?: unknown; error?: string } = {
                success: false,
                error: executionError || 'Failed to set leverage',
              };
              if (!executionError) {
                const attempts = [3, 2, 1, 0];
                let lastError: string | undefined;
                for (const decimals of attempts) {
                  const qtyStr = formatQty(quantity, decimals);
                  if (!qtyStr) continue;
                  const attemptResult = await callBybitApi(
                    '/v5/order/create',
                    apiKey,
                    apiSecret,
                    isTestnet,
                    'POST',
                    {
                      category: 'linear',
                      symbol: pair,
                      side,
                      orderType: 'Market',
                      qty: qtyStr,
                    }
                  );
                  if (attemptResult.success) {
                    orderResult = attemptResult;
                    orderQtyDecimals = decimals;
                    break;
                  }
                  lastError = attemptResult.error;
                  if (!isPrecisionError(attemptResult.error)) {
                    orderResult = attemptResult;
                    break;
                  }
                }
                if (!orderResult.success && lastError) {
                  orderResult = { success: false, error: lastError };
                }
              }

              if (orderResult.success) {
                const orderData = orderResult.data as { result?: { orderId?: string } };
                orderId = orderData.result?.orderId;
                orderSuccess = true;

                // Place SL/TP orders
                if (price > 0) {
                  const slPrice = side === 'Buy'
                    ? price * (1 - config.stop_loss_percent / 100)
                    : price * (1 + config.stop_loss_percent / 100);

                  await callBybitApi('/v5/position/trading-stop', apiKey, apiSecret, isTestnet, 'POST', {
                    category: 'linear',
                    symbol: pair,
                    positionIdx: 0,
                    stopLoss: slPrice.toFixed(2),
                    slTriggerBy: 'LastPrice',
                  });

                  const closeSide = side === 'Buy' ? 'Sell' : 'Buy';
                  const tpLevels = [
                    { enabled: config.use_tp1, percent: config.tp1_percent, closePercent: config.tp1_close_percent },
                    { enabled: config.use_tp2, percent: config.tp2_percent, closePercent: config.tp2_close_percent },
                    { enabled: config.use_tp3, percent: config.tp3_percent, closePercent: config.tp3_close_percent },
                  ];
                  const decimals = orderQtyDecimals ?? 3;

                  for (const tp of tpLevels) {
                    if (!tp.enabled) continue;
                    const tpPrice = side === 'Buy'
                      ? price * (1 + tp.percent / 100)
                      : price * (1 - tp.percent / 100);
                    const tpQty = Math.floor(roundedQty * (tp.closePercent / 100) * 1000) / 1000;
                    const tpQtyStr = formatQty(tpQty, decimals);

                    if (tpQtyStr) {
                      const tpResult = await callBybitApi('/v5/order/create', apiKey, apiSecret, isTestnet, 'POST', {
                        category: 'linear',
                        symbol: pair,
                        side: closeSide,
                        orderType: 'Market',
                        qty: tpQtyStr,
                        reduceOnly: true,
                        closeOnTrigger: true,
                        triggerPrice: tpPrice.toFixed(2),
                        triggerBy: 'LastPrice',
                      });
                      if (!tpResult.success) {
                        executionError = tpResult.error || 'Bybit TP failed';
                      }
                    }
                  }

                  const useTrailingStop2 = getConfigBoolean(strategyConfig, 'use_trailing_stop', false);
                  const trailingStopCallback2 = getConfigNumber(strategyConfig, 'trailing_stop_callback', 0);
                  const trailingStopActivation2 = getConfigNumber(strategyConfig, 'trailing_stop_activation', 0);
                  if (useTrailingStop2 && trailingStopCallback2 > 0) {
                    const trailingDistance = price * (trailingStopCallback2 / 100);
                    const activePrice = trailingStopActivation2 > 0
                      ? side === 'Buy'
                        ? price * (1 + trailingStopActivation2 / 100)
                        : price * (1 - trailingStopActivation2 / 100)
                      : 0;
                    const params: Record<string, unknown> = {
                      category: 'linear',
                      symbol: pair,
                      positionIdx,
                      trailingStop: trailingDistance.toFixed(2),
                    };
                    if (activePrice > 0) {
                      params.activePrice = activePrice.toFixed(2);
                    }
                    const trailingResult = await callBybitApi('/v5/position/trading-stop', apiKey, apiSecret, isTestnet, 'POST', params);
                    if (!trailingResult.success) {
                      executionError = trailingResult.error || 'Bybit trailing stop failed';
                    }
                  }
                }
              }
              if (!orderResult.success) {
                executionError = orderResult.error || 'Bybit order failed';
              }
            }

            if (orderSuccess && orderId) {
              // Record trade in database
              const tradeId = crypto.randomUUID();
              const trade: Trade = {
                id: tradeId,
                user_id: config.user_id,
                exchange: config.exchange as string,
                environment: (config.environment as 'testnet' | 'mainnet') || 'testnet',
                symbol: pair,
                side: signal.action,
                order_type: 'market',
                price: signal.price,
                quantity,
                status: 'filled',
                order_id: orderId,
                triggered_by: 'auto_strategy',
                created_at: new Date().toISOString(),
              };

              db.data?.trades.push(trade);

              // Record position
              const positionId = crypto.randomUUID();
              db.data?.positions.push({
                id: positionId,
                user_id: config.user_id,
                exchange: config.exchange as string,
                environment: (config.environment as 'testnet' | 'mainnet') || 'testnet',
                symbol: pair,
                side: signal.action === 'buy' ? 'long' : 'short',
                size: quantity,
                entry_price: signal.price,
                unrealized_pnl: 0,
                leverage,
                is_open: true,
                stop_loss:
                  signal.action === 'buy'
                    ? signal.price * (1 - config.stop_loss_percent / 100)
                    : signal.price * (1 + config.stop_loss_percent / 100),
                take_profit: config.use_tp1
                  ? signal.action === 'buy'
                    ? signal.price * (1 + config.tp1_percent / 100)
                    : signal.price * (1 - config.tp1_percent / 100)
                  : null,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
              });

              // Update last_signal_at
              const strategyIndex = db.data?.trading_strategies.findIndex((s) => s.id === config.id);
              if (strategyIndex !== undefined && strategyIndex >= 0 && db.data) {
                (db.data.trading_strategies[strategyIndex] as StrategyConfig).last_signal_at =
                  new Date().toISOString();
              }

              // Log webhook
              const webhookLogId = crypto.randomUUID();
              db.data?.webhook_logs.push({
                id: webhookLogId,
                user_id: config.user_id,
                strategy_id: config.id,
                payload: {
                  source: 'auto_strategy_direct',
                  signal: {
                    action: signal.action,
                    symbol: pair,
                    price: signal.price,
                    confidence: signal.confidence,
                  },
                  filter: geminiDecision
                    ? {
                      provider: 'gemini',
                      execute: geminiDecision.execute,
                      confidence: geminiDecision.confidence,
                      reason: geminiDecision.reason,
                    }
                    : {
                      provider: 'engine_only',
                      reason: skipReason || 'engine_confidence',
                    },
                  orderId,
                },
                status: 'executed',
                error_message: null,
                created_at: new Date().toISOString(),
              });

              await safeWrite();

              results.push({
                strategy: config.name,
                pair,
                signal: {
                  action: signal.action,
                  symbol: pair,
                  price: signal.price,
                  confidence: signal.confidence,
                },
                executed: true,
                tradeId,
              });

              console.log(
                `✅ Auto signal EXECUTED: ${pair} ${signal.action} for strategy ${config.name} | Signal confidence: ${(signal.confidence * 100).toFixed(1)}%`
              );
            } else {
              const webhookLogId = crypto.randomUUID();
              db.data?.webhook_logs.push({
                id: webhookLogId,
                user_id: config.user_id,
                strategy_id: config.id,
                payload: {
                  source: 'auto_strategy_direct',
                  signal: {
                    action: signal.action,
                    symbol: pair,
                    price: signal.price,
                    confidence: signal.confidence,
                  },
                  filter: geminiDecision
                    ? {
                      provider: 'gemini',
                      execute: geminiDecision.execute,
                      confidence: geminiDecision.confidence,
                      reason: geminiDecision.reason,
                    }
                    : {
                      provider: 'engine_only',
                      reason: skipReason || 'engine_confidence',
                    },
                },
                status: 'failed',
                error_message: executionError || 'Trade execution failed',
                created_at: new Date().toISOString(),
              });
              await safeWrite();

              results.push({
                strategy: config.name,
                pair,
                signal: {
                  action: signal.action,
                  symbol: pair,
                  price: signal.price,
                  confidence: signal.confidence,
                },
                executed: false,
                reason: 'Trade execution failed',
              });
            }
          } else {
            if (signal.action === 'buy' || signal.action === 'sell') {
              const webhookLogId = crypto.randomUUID();
              db.data?.webhook_logs.push({
                id: webhookLogId,
                user_id: config.user_id,
                strategy_id: config.id,
                payload: {
                  source: 'auto_strategy_direct',
                  signal: {
                    action: signal.action,
                    symbol: pair,
                    price: signal.price,
                    confidence: signal.confidence,
                  },
                  filter: geminiDecision
                    ? {
                      provider: 'gemini',
                      execute: geminiDecision.execute,
                      confidence: geminiDecision.confidence,
                      reason: geminiDecision.reason,
                    }
                    : {
                      provider: 'engine_only',
                      reason: skipReason || 'engine_confidence',
                    },
                },
                status: 'filtered',
                error_message: skipReason || 'Signal filtered',
                created_at: new Date().toISOString(),
              });
              await safeWrite();
            }

            results.push({
              strategy: config.name,
              pair,
              signal: signal.action === 'buy' || signal.action === 'sell' ? {
                action: signal.action,
                symbol: pair,
                price: signal.price,
                confidence: signal.confidence,
              } : null,
              executed: false,
              reason: skipReason || 'Signal filtered',
            });
          }
        } catch (error) {
          console.error(`Error processing ${pair} for strategy ${config.id}:`, error);
        }
      }
    }

    // Calculate summary
    const executedCount = results.filter((r) => r.executed).length;
    const totalSignals = results.filter((r) => r.signal !== null).length;

    console.log(`📊 Auto-signal Summary: ${executedCount} executed, ${totalSignals} signals generated`);

    return res.json({
      processed: strategies.length,
      results,
      summary: {
        executed: executedCount,
        totalSignals,
        timestamp: new Date().toISOString(),
      },
      timestamp: new Date().toISOString(),
      mode: 'direct_execution',
    });
  } catch (error) {
    console.error('Auto-signal generator error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export const autoSignalGeneratorRouter = router;
