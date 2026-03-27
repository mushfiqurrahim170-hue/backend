import { Router } from 'express';
import type { Request, Response } from 'express';
import '../config/env.js';
import bcrypt from 'bcryptjs';
import jwt, { type SignOptions } from 'jsonwebtoken';
import { db, safeWrite } from '../db/index.js';
import crypto from 'node:crypto';

const router = Router();

const jwtSecret = process.env.JWT_SECRET;
if (!jwtSecret) {
  throw new Error('Missing JWT_SECRET');
}

const jwtExpiresIn = process.env.JWT_EXPIRES_IN || '7d';

const createAccessToken = (authUserId: string, email: string): string => {
  return jwt.sign(
    {
      sub: authUserId,
      email,
      role: 'authenticated',
      aud: 'authenticated',
    },
    jwtSecret,
    {
      expiresIn: jwtExpiresIn,
    } as SignOptions
  );
};

const handleRegister = async (req: Request, res: Response) => {
  try {
    const { email, password, referralCode } = req.body as {
      email?: string;
      password?: string;
      referralCode?: string;
    };

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const existing = db.data?.app_users.find((u) => u.email === email.toLowerCase());
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }
    const passwordHash = await bcrypt.hash(password, 10);
    const userId = crypto.randomUUID();
    const now = new Date().toISOString();

    // Ensure all arrays exist
    db.data ||= {
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
      app_settings: [],
    };

    // Create app_user
    db.data.app_users.push({
      id: userId,
      email: email.toLowerCase(),
      password_hash: passwordHash,
      created_at: now,
    });

    // Create profile
    let referrerProfileId: string | null = null;
    if (referralCode) {
      // Find referrer by referral code
      const referrer = db.data.profiles.find((p) => p.referral_code?.toLowerCase() === referralCode.toLowerCase());
      if (referrer) {
        referrerProfileId = referrer.id;
      }
    }

    db.data.profiles.push({
      id: crypto.randomUUID(),
      user_id: userId,
      display_name: null,
      email: email.toLowerCase(),
      referrer_id: referrerProfileId,
      referral_code: crypto.randomBytes(8).toString('hex'),
      created_at: now,
      updated_at: now,
    });

    // Create bot_status
    db.data.bot_status.push({
      id: crypto.randomUUID(),
      user_id: userId,
      is_running: false,
      environment: 'testnet',
      exchange: 'binance',
      last_trade_at: null,
      total_trades: 0,
      successful_trades: 0,
      failed_trades: 0,
      created_at: now,
      updated_at: now,
    });

    // Create gas_fee_balances for both environments
    db.data.gas_fee_balances.push({
      id: crypto.randomUUID(),
      user_id: userId,
      environment: 'testnet',
      balance: 0,
      total_deposited: 0,
      total_deducted: 0,
      created_at: now,
      updated_at: now,
    });

    db.data.gas_fee_balances.push({
      id: crypto.randomUUID(),
      user_id: userId,
      environment: 'mainnet',
      balance: 0,
      total_deposited: 0,
      total_deducted: 0,
      created_at: now,
      updated_at: now,
    });

    await safeWrite();

    const token = createAccessToken(userId, email.toLowerCase());
    return res.status(201).json({
      token,
      user: { id: userId, email: email.toLowerCase() },
    });
  } catch (error) {
    console.error('Register error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
};

router.post('/register', handleRegister);
router.post('/signup', handleRegister);

router.post('/login', async (req, res) => {
  try {
    const { email, password } = req.body as { email?: string; password?: string };
    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const appUser = db.data?.app_users.find((u) => u.email === email.toLowerCase());
    if (!appUser) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const ok = await bcrypt.compare(password, appUser.password_hash);
    if (!ok) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }
    const token = createAccessToken(appUser.id, appUser.email);
    return res.json({
      token,
      user: { id: appUser.id, email: appUser.email },
    });
  } catch (error) {
    console.error('Login error:', error);
    return res.status(500).json({ error: 'Internal error' });
  }
});

router.get('/me', (req, res) => {
  try {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.slice('Bearer '.length);
    const payload = jwt.verify(token, jwtSecret) as { sub: string; email?: string };
    return res.json({ user: { id: payload.sub, email: payload.email ?? null } });
  } catch (error) {
    return res.status(401).json({ error: 'Invalid token' });
  }
});

export const authRouter = router;

