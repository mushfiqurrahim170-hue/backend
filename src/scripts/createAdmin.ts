import '../config/env.js';
import bcrypt from 'bcryptjs';
import { db, safeWrite, initDb } from '../db/index.js';
import crypto from 'node:crypto';

async function createAdmin() {
  const adminEmail = 'admin@mail.com';
  const adminPassword = 'Admin@2026';

  // Initialize database first
  await initDb();
  await db.read();
  
  // Ensure all arrays exist
  if (!db.data) {
    throw new Error('Database not initialized');
  }
  
  db.data.app_users ||= [];
  db.data.user_roles ||= [];
  db.data.profiles ||= [];
  db.data.bot_status ||= [];
  db.data.gas_fee_balances ||= [];

  // Check if admin already exists
  const existingAdmin = db.data.app_users.find((u) => u.email === adminEmail.toLowerCase());
  if (existingAdmin) {
    console.log('Admin user already exists:', adminEmail);
    
    // Check if admin role exists
    const existingRole = db.data.user_roles.find(
      (r) => r.user_id === existingAdmin.id && r.role === 'admin'
    );
    
    if (!existingRole) {
      // Add admin role
      db.data.user_roles.push({
        id: crypto.randomUUID(),
        user_id: existingAdmin.id,
        role: 'admin',
        created_at: new Date().toISOString(),
      });
      await safeWrite();
      console.log('Admin role assigned to existing user');
    } else {
      console.log('Admin role already assigned');
    }
    return;
  }

  // Create admin user
  const userId = crypto.randomUUID();
  const passwordHash = await bcrypt.hash(adminPassword, 10);
  const now = new Date().toISOString();

  // Add to app_users
  db.data.app_users.push({
    id: userId,
    email: adminEmail.toLowerCase(),
    password_hash: passwordHash,
    created_at: now,
  });

  // Add admin role
  db.data.user_roles.push({
    id: crypto.randomUUID(),
    user_id: userId,
    role: 'admin',
    created_at: now,
  });

  // Create profile
  db.data.profiles.push({
    id: crypto.randomUUID(),
    user_id: userId,
    display_name: 'Admin',
    email: adminEmail.toLowerCase(),
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

  // Create gas_fee_balance for testnet
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

  // Create gas_fee_balance for mainnet
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
  console.log('✅ Admin user created successfully!');
  console.log('Email:', adminEmail);
  console.log('Password:', adminPassword);
  console.log('User ID:', userId);
}

createAdmin().catch(console.error);

