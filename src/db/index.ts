import '../config/env.js';
import { Low } from 'lowdb';
import { JSONFile } from 'lowdb/node';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promises as fs } from 'node:fs';

export type AppUser = {
  id: string;
  email: string;
  password_hash: string;
  created_at: string;
};

export type ApiKey = {
  id: string;
  user_id: string;
  key_name: string;
  exchange: string;
  product: string;
  environment: string;
  api_key_encrypted: string;
  api_secret_encrypted: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
};

export type TradingStrategy = {
  id: string;
  user_id: string;
  name: string;
  webhook_secret?: string | null;
  is_active: boolean;
  [key: string]: unknown;
};

export type Trade = {
  id: string;
  user_id: string;
  exchange: string;
  environment: string;
  symbol: string;
  side: string;
  order_type: string;
  price: number;
  quantity: number;
  realized_pnl?: number;
  status: string;
  order_id?: string | null;
  triggered_by?: string | null;
  created_at: string;
};

export type WebhookLog = {
  id: string;
  user_id: string;
  strategy_id: string;
  payload: Record<string, unknown>;
  status: string;
  error_message?: string | null;
  created_at: string;
};

export type UserRole = {
  id: string;
  user_id: string;
  role: string;
  created_at: string;
};

export type BotStatus = {
  id: string;
  user_id: string;
  is_running: boolean;
  environment: 'testnet' | 'mainnet';
  exchange?: string;
  last_trade_at: string | null;
  total_trades: number;
  successful_trades: number;
  failed_trades: number;
  created_at: string;
  updated_at: string;
};

export type Profile = {
  id: string;
  user_id: string;
  display_name?: string | null;
  email?: string | null;
  referrer_id?: string | null;
  referral_code?: string | null;
  created_at: string;
  updated_at: string;
};

export type Position = {
  id: string;
  user_id: string;
  symbol: string;
  side: 'long' | 'short';
  size: number;
  entry_price: number;
  current_price?: number | null;
  unrealized_pnl: number;
  leverage: number;
  margin?: number | null;
  liquidation_price?: number | null;
  stop_loss?: number | null;
  take_profit?: number | null;
  is_open: boolean;
  exchange: string;
  environment: 'testnet' | 'mainnet';
  created_at: string;
  updated_at: string;
};

export type AccountBalance = {
  id: string;
  user_id: string;
  exchange: string;
  product: string;
  environment: 'testnet' | 'mainnet';
  asset: string;
  balance: number;
  available_balance: number;
  unrealized_pnl: number;
  updated_at: string;
};

export type GasFeeBalance = {
  id: string;
  user_id: string;
  environment: 'testnet' | 'mainnet';
  balance: number;
  total_deposited: number;
  total_deducted: number;
  created_at: string;
  updated_at: string;
};

export type GasFeeTransaction = {
  id: string;
  user_id: string;
  amount: number;
  transaction_type: 'deposit' | 'service_fee' | 'refund' | 'demo_deposit' | 'referral_commission';
  description?: string | null;
  trade_id?: string | null;
  balance_before: number;
  balance_after: number;
  environment?: 'testnet' | 'mainnet';
  created_at: string;
};

export type ReferralCommission = {
  id: string;
  beneficiary_user_id: string;
  source_user_id: string;
  trade_id?: string | null;
  level: number;
  gross_profit: number;
  commission_rate: number;
  commission_amount: number;
  status: 'pending' | 'paid' | 'cancelled';
  created_at: string;
  paid_at?: string | null;
};

export type AdminEarning = {
  id: string;
  source_user_id?: string | null;
  trade_id?: string | null;
  gross_profit: number;
  total_service_fee: number;
  referral_commissions_paid: number;
  admin_share: number;
  created_at: string;
};

export type ProfitSettlement = {
  id: string;
  user_id: string;
  trade_id?: string | null;
  gross_profit: number;
  service_fee_rate: number;
  service_fee_amount: number;
  net_profit: number;
  created_at: string;
};

export type PendingDeposit = {
  id: string;
  user_id: string;
  amount: number;
  environment: 'testnet' | 'mainnet';
  transaction_hash?: string | null;
  wallet_address?: string | null;
  proof_screenshot_url?: string | null;
  status: 'pending' | 'approved' | 'rejected';
  admin_notes?: string | null;
  approved_by?: string | null;
  approved_at?: string | null;
  created_at: string;
};

export type DepositAddress = {
  id: string;
  network: string;
  address: string;
  label?: string | null;
  is_active: boolean;
  created_by?: string | null;
  created_at: string;
  updated_at: string;
};

export type UserSetting = {
  id: string;
  user_id: string;
  notify_trade_executed: boolean;
  notify_stop_loss_hit: boolean;
  notify_take_profit_hit: boolean;
  notify_bot_errors: boolean;
  max_daily_trades?: number | null;
  max_position_size_percent?: number | null;
  daily_loss_limit?: number | null;
  created_at: string;
  updated_at: string;
};

export type AppSetting = {
  key: string;
  bool_value: boolean;
  updated_at: string;
  created_at: string;
};

type Data = {
  app_users: AppUser[];
  api_keys: ApiKey[];
  trading_strategies: TradingStrategy[];
  webhook_logs: WebhookLog[];
  user_roles: UserRole[];
  trades: Trade[];
  bot_status: BotStatus[];
  profiles: Profile[];
  positions: Position[];
  account_balances: AccountBalance[];
  gas_fee_balances: GasFeeBalance[];
  gas_fee_transactions: GasFeeTransaction[];
  referral_commissions: ReferralCommission[];
  admin_earnings: AdminEarning[];
  profit_settlements: ProfitSettlement[];
  pending_deposits: PendingDeposit[];
  deposit_addresses: DepositAddress[];
  user_settings: UserSetting[];
  app_settings: AppSetting[];
};

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dbDir = path.resolve(__dirname, '../../data');
const dbFile = path.resolve(dbDir, 'db.json');

const adapter = new JSONFile<Data>(dbFile);
const defaultData: Data = {
  app_users: [],
  api_keys: [],
  trading_strategies: [],
  webhook_logs: [],
  user_roles: [],
  trades: [],
  bot_status: [],
  profiles: [],
  positions: [],
  account_balances: [],
  gas_fee_balances: [],
  gas_fee_transactions: [],
  referral_commissions: [],
  admin_earnings: [],
  profit_settlements: [],
  pending_deposits: [],
  deposit_addresses: [],
  user_settings: [],
  app_settings: [{ key: 'maintenance_mode', bool_value: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }],
};

export const db = new Low<Data>(adapter, defaultData);

// Wrapper for safe writes with retry logic (handles Windows EPERM errors)
export async function safeWrite(retries = 5, delay = 200) {
  for (let i = 0; i < retries; i++) {
    try {
      await db.write();
      return;
    } catch (error: unknown) {
      const err = error as { code?: string; message?: string };
      if ((err.code === 'EPERM' || err.code === 'EBUSY') && i < retries - 1) {
        console.warn(`[db] Write failed (attempt ${i + 1}/${retries}): ${err.message || err.code}, retrying...`);
        await new Promise((resolve) => setTimeout(resolve, delay * (i + 1)));
        continue;
      }
      console.error(`[db] Write failed after ${retries} attempts:`, err);
      throw error;
    }
  }
}

export async function initDb() {
  await fs.mkdir(dbDir, { recursive: true });
  
  // Check if file exists and is readable
  try {
    await fs.access(dbFile);
  } catch {
    // File doesn't exist, create empty file first
    await fs.writeFile(dbFile, JSON.stringify(defaultData, null, 2), 'utf-8');
  }
  
  await db.read();
  db.data ||= { ...defaultData };
  await safeWrite();
}

