import '../config/env.js';
import { db, safeWrite, initDb } from '../db/index.js';
import crypto from 'node:crypto';

async function createMissingProfiles() {
  await initDb();
  await db.read();

  if (!db.data) {
    throw new Error('Database not initialized');
  }

  db.data.app_users ||= [];
  db.data.profiles ||= [];
  db.data.bot_status ||= [];
  db.data.gas_fee_balances ||= [];

  let created = 0;
  const now = new Date().toISOString();

  for (const user of db.data.app_users) {
    // Check if profile exists
    const existingProfile = db.data.profiles.find((p) => p.user_id === user.id);
    if (!existingProfile) {
      // Create profile
      db.data.profiles.push({
        id: crypto.randomUUID(),
        user_id: user.id,
        display_name: null,
        email: user.email,
        referrer_id: null,
        referral_code: crypto.randomBytes(8).toString('hex'),
        created_at: now,
        updated_at: now,
      });
      created++;
      console.log(`Created profile for user: ${user.email}`);
    }

    // Check if bot_status exists
    const existingBotStatus = db.data.bot_status.find((b) => b.user_id === user.id);
    if (!existingBotStatus) {
      db.data.bot_status.push({
        id: crypto.randomUUID(),
        user_id: user.id,
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
      console.log(`Created bot_status for user: ${user.email}`);
    }

    // Check if gas_fee_balances exist
    const existingTestnetBalance = db.data.gas_fee_balances.find(
      (b) => b.user_id === user.id && b.environment === 'testnet'
    );
    if (!existingTestnetBalance) {
      db.data.gas_fee_balances.push({
        id: crypto.randomUUID(),
        user_id: user.id,
        environment: 'testnet',
        balance: 0,
        total_deposited: 0,
        total_deducted: 0,
        created_at: now,
        updated_at: now,
      });
      console.log(`Created testnet gas_fee_balance for user: ${user.email}`);
    }

    const existingMainnetBalance = db.data.gas_fee_balances.find(
      (b) => b.user_id === user.id && b.environment === 'mainnet'
    );
    if (!existingMainnetBalance) {
      db.data.gas_fee_balances.push({
        id: crypto.randomUUID(),
        user_id: user.id,
        environment: 'mainnet',
        balance: 0,
        total_deposited: 0,
        total_deducted: 0,
        created_at: now,
        updated_at: now,
      });
      console.log(`Created mainnet gas_fee_balance for user: ${user.email}`);
    }
  }

  await safeWrite();
  console.log(`\n✅ Created ${created} missing profiles`);
  console.log(`Total users: ${db.data.app_users.length}`);
  console.log(`Total profiles: ${db.data.profiles.length}`);
}

createMissingProfiles().catch(console.error);

