import { Router } from 'express';
import crypto from 'node:crypto';
import { fetch } from 'undici';
import { db, safeWrite, type Position, type ApiKey, type Trade, type Profile, type GasFeeBalance } from '../db/index.js';
import { createHmac } from 'node:crypto';

const router = Router();
const SERVICE_FEE_RATE = 0.3;
const REFERRAL_RATES = [0.005, 0.003, 0.002];

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

async function checkExchangePosition(
  symbol: string,
  exchange: string,
  product: string,
  isTestnet: boolean,
  apiKey: string,
  apiSecret: string
): Promise<{ isOpen: boolean; currentSize: number; unrealizedPnl: number; currentPrice: number }> {
  if (exchange === 'binance' && product === 'futures') {
    const result = await callBinanceApi('/fapi/v2/positionRisk', apiKey, apiSecret, isTestnet, product, 'GET', { symbol });
    
    if (result.success && Array.isArray(result.data)) {
      const positions = result.data as Array<{ symbol: string; positionAmt: string; unRealizedProfit: string; markPrice: string }>;
      const position = positions.find(p => p.symbol === symbol);
      
      if (position) {
        const size = parseFloat(position.positionAmt);
        return {
          isOpen: size !== 0,
          currentSize: Math.abs(size),
          unrealizedPnl: parseFloat(position.unRealizedProfit) || 0,
          currentPrice: parseFloat(position.markPrice) || 0,
        };
      }
    }
  } else if (exchange === 'bybit') {
    const result = await callBybitApi('/v5/position/list', apiKey, apiSecret, isTestnet, 'GET', { 
      category: 'linear',
      symbol 
    });
    
    if (result.success && result.data) {
      type BybitPositionResponse = {
        result?: {
          list?: Array<{
            symbol: string;
            size: string;
            unrealisedPnl: string;
            markPrice: string;
          }>;
        };
      };
      const data = result.data as BybitPositionResponse;
      const position = data.result?.list?.[0];
      
      if (position) {
        const size = parseFloat(position.size);
        return {
          isOpen: size !== 0,
          currentSize: size,
          unrealizedPnl: parseFloat(position.unrealisedPnl) || 0,
          currentPrice: parseFloat(position.markPrice) || 0,
        };
      }
    }
  }
  
  return { isOpen: false, currentSize: 0, unrealizedPnl: 0, currentPrice: 0 };
}

const getReferralChain = (userId: string): Array<{ level: number; referrerProfile: Profile }> => {
  const chain: Array<{ level: number; referrerProfile: Profile }> = [];
  if (!db.data) return chain;

  let currentProfile = db.data.profiles.find((p) => p.user_id === userId);
  let level = 1;

  while (currentProfile?.referrer_id && level <= 3) {
    const referrerProfile = db.data.profiles.find((p) => p.id === currentProfile?.referrer_id);
    if (!referrerProfile) break;
    chain.push({ level, referrerProfile });
    currentProfile = referrerProfile;
    level += 1;
  }

  return chain;
};

const getOrCreateGasBalance = (userId: string, environment: 'testnet' | 'mainnet'): GasFeeBalance => {
  const now = new Date().toISOString();
  const existing = (db.data?.gas_fee_balances || []).find(
    (b) => b.user_id === userId && b.environment === environment
  );
  if (existing) return existing;

  const created: GasFeeBalance = {
    id: crypto.randomUUID(),
    user_id: userId,
    environment,
    balance: 0,
    total_deposited: 0,
    total_deducted: 0,
    created_at: now,
    updated_at: now,
  };
  db.data?.gas_fee_balances.push(created);
  return created;
};

const processProfitSharing = (
  userId: string,
  tradeId: string,
  grossProfit: number,
  environment: 'testnet' | 'mainnet'
) => {
  if (!db.data || grossProfit <= 0) return;

  const now = new Date().toISOString();
  const serviceFee = grossProfit * SERVICE_FEE_RATE;
  const netProfit = grossProfit - serviceFee;

  db.data.profit_settlements.push({
    id: crypto.randomUUID(),
    user_id: userId,
    trade_id: tradeId,
    gross_profit: grossProfit,
    service_fee_rate: SERVICE_FEE_RATE,
    service_fee_amount: serviceFee,
    net_profit: netProfit,
    created_at: now,
  });

  const userBalance = getOrCreateGasBalance(userId, environment);
  const balanceBefore = userBalance.balance;
  userBalance.balance = balanceBefore - serviceFee;
  userBalance.total_deducted = (userBalance.total_deducted || 0) + serviceFee;
  userBalance.updated_at = now;

  db.data.gas_fee_transactions.push({
    id: crypto.randomUUID(),
    user_id: userId,
    amount: -serviceFee,
    transaction_type: 'service_fee',
    description: 'Service fee for profitable trade',
    trade_id: tradeId,
    balance_before: balanceBefore,
    balance_after: userBalance.balance,
    environment,
    created_at: now,
  });

  let totalReferralPaid = 0;
  const referralChain = getReferralChain(userId);
  for (const entry of referralChain) {
    const rate = REFERRAL_RATES[entry.level - 1] || 0;
    const commission = grossProfit * rate;
    if (commission <= 0) continue;

    const beneficiaryUserId = entry.referrerProfile.user_id;

    db.data.referral_commissions.push({
      id: crypto.randomUUID(),
      beneficiary_user_id: beneficiaryUserId,
      source_user_id: userId,
      trade_id: tradeId,
      level: entry.level,
      gross_profit: grossProfit,
      commission_rate: rate,
      commission_amount: commission,
      status: 'paid',
      created_at: now,
      paid_at: now,
    });

    const beneficiaryBalance = getOrCreateGasBalance(beneficiaryUserId, environment);
    const beneficiaryBefore = beneficiaryBalance.balance;
    beneficiaryBalance.balance = beneficiaryBefore + commission;
    beneficiaryBalance.total_deposited = (beneficiaryBalance.total_deposited || 0) + commission;
    beneficiaryBalance.updated_at = now;

    db.data.gas_fee_transactions.push({
      id: crypto.randomUUID(),
      user_id: beneficiaryUserId,
      amount: commission,
      transaction_type: 'referral_commission',
      description: `Referral commission (level ${entry.level})`,
      trade_id: tradeId,
      balance_before: beneficiaryBefore,
      balance_after: beneficiaryBalance.balance,
      environment,
      created_at: now,
    });

    totalReferralPaid += commission;
  }

  const adminShare = serviceFee - totalReferralPaid;
  db.data.admin_earnings.push({
    id: crypto.randomUUID(),
    source_user_id: userId,
    trade_id: tradeId,
    gross_profit: grossProfit,
    total_service_fee: serviceFee,
    referral_commissions_paid: totalReferralPaid,
    admin_share: adminShare,
    created_at: now,
  });
};

router.post('/', async (_req, res) => {
  try {
    await db.read();
    if (!db.data) {
      return res.status(500).json({ error: 'Database not initialized' });
    }

    // Ensure required tables exist
    db.data.trades ||= [];
    db.data.positions ||= [];
    db.data.gas_fee_balances ||= [];
    db.data.gas_fee_transactions ||= [];
    db.data.profit_settlements ||= [];
    db.data.referral_commissions ||= [];
    db.data.admin_earnings ||= [];
    db.data.profiles ||= [];
    
    console.log('Position monitor started...');

    // Backfill profit settlements for closed trades with realized PnL
    if (db.data) {
      db.data.profit_settlements ||= [];
      const settledTradeIds = new Set(
        db.data.profit_settlements
          .map((s) => s.trade_id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      );

      const profitableTrades = (db.data.trades || []).filter(
        (t) => (t.realized_pnl ?? 0) > 0 && t.status === 'filled'
      );

      for (const trade of profitableTrades) {
        if (settledTradeIds.has(trade.id)) continue;
        processProfitSharing(
          trade.user_id,
          trade.id,
          Number(trade.realized_pnl || 0),
          (trade.environment as 'testnet' | 'mainnet') || 'testnet'
        );
        settledTradeIds.add(trade.id);
      }
    }
    
    // Get all open positions from database
    const positions = (db.data?.positions || []).filter(p => p.is_open);
    
    if (positions.length === 0) {
      return res.json({ message: 'No open positions to monitor' });
    }
    
    console.log(`Monitoring ${positions.length} open positions...`);
    
    // Group positions by user and exchange for efficient API calls
    const userPositions = new Map<string, Position[]>();
    for (const pos of positions) {
      const key = `${pos.user_id}-${pos.exchange}-${pos.environment}`;
      if (!userPositions.has(key)) {
        userPositions.set(key, []);
      }
      userPositions.get(key)!.push(pos);
    }
    
    const results: Array<{
      position_id: string;
      symbol: string;
      status: string;
      trigger?: string;
      realized_pnl?: number;
    }> = [];
    
    for (const [key, userPosGroup] of userPositions.entries()) {
      const [userId, exchange, environment] = key.split('-');
      const product = 'futures'; // Assuming futures for now
      
      // Get API keys for this user/exchange/environment
      const apiKeys = (db.data?.api_keys || []).find(
        (k) =>
          k.user_id === userId &&
          k.exchange === exchange &&
          k.product === product &&
          k.environment === environment &&
          k.is_active
      ) as ApiKey | undefined;
      
      if (!apiKeys) {
        console.log(`No API keys found for ${key}`);
        continue;
      }
      
      const apiKey = decryptValue(apiKeys.api_key_encrypted);
      const apiSecret = decryptValue(apiKeys.api_secret_encrypted);
      const isTestnet = environment === 'testnet';
      
      for (const position of userPosGroup) {
        try {
          // Check current position on exchange
          const exchangePos = await checkExchangePosition(
            position.symbol,
            exchange,
            product,
            isTestnet,
            apiKey,
            apiSecret
          );
          
          // Update current price in database
          if (exchangePos.currentPrice > 0) {
            const posIndex = db.data?.positions.findIndex(p => p.id === position.id);
            if (posIndex !== undefined && posIndex >= 0 && db.data) {
              db.data.positions[posIndex].current_price = exchangePos.currentPrice;
              db.data.positions[posIndex].unrealized_pnl = exchangePos.unrealizedPnl;
              db.data.positions[posIndex].updated_at = new Date().toISOString();
            }
          }
          
          // If position is closed on exchange but open in DB
          if (!exchangePos.isOpen && position.is_open) {
            console.log(`Position ${position.symbol} closed on exchange, updating DB...`);
            
            const posIndex = db.data?.positions.findIndex(p => p.id === position.id);
            if (posIndex !== undefined && posIndex >= 0 && db.data) {
              db.data.positions[posIndex].is_open = false;
              db.data.positions[posIndex].unrealized_pnl = exchangePos.unrealizedPnl;
              db.data.positions[posIndex].updated_at = new Date().toISOString();
              
              // Record trade
              const tradeId = crypto.randomUUID();
              db.data.trades.push({
                id: tradeId,
                user_id: position.user_id,
                exchange: position.exchange,
                environment: position.environment as 'testnet' | 'mainnet',
                symbol: position.symbol,
                side: position.side === 'long' ? 'sell' : 'buy',
                order_type: 'market',
                price: exchangePos.currentPrice || position.entry_price,
                quantity: position.size,
                realized_pnl: exchangePos.unrealizedPnl,
                status: 'filled',
                order_id: null,
                triggered_by: 'position_monitor',
                created_at: new Date().toISOString(),
              });

              processProfitSharing(
                position.user_id,
                tradeId,
                exchangePos.unrealizedPnl,
                position.environment as 'testnet' | 'mainnet'
              );
              
              results.push({
                position_id: position.id,
                symbol: position.symbol,
                status: 'closed',
                trigger: 'exchange_close',
                realized_pnl: exchangePos.unrealizedPnl,
              });
            }
          }
        } catch (error) {
          console.error(`Error monitoring position ${position.id}:`, error);
        }
      }
    }
    
    await safeWrite();
    
    console.log(`Position monitor completed: ${results.length} positions closed`);
    
    return res.json({
      monitored: positions.length,
      closed: results.length,
      results,
      timestamp: new Date().toISOString(),
    });
  } catch (error) {
    console.error('Position monitor error:', error);
    return res.status(500).json({
      error: error instanceof Error ? error.message : 'Unknown error',
    });
  }
});

export const positionMonitorRouter = router;
