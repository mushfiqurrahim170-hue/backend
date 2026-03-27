import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { db, safeWrite } from '../db/index.js';
import crypto from 'node:crypto';

const router = Router();

router.post('/has_role', requireAuth, async (req: AuthenticatedRequest, res) => {
  const { _user_id, _role } = req.body as { _user_id?: string; _role?: string };
  if (!_role) {
    return res.status(400).json({ error: 'Missing _role' });
  }

  // Use current authenticated user's ID if _user_id not provided or matches current user
  // This allows users to check their own role, and admins can check any user's role
  const targetUserId = _user_id || req.user?.id;
  if (!targetUserId) {
    return res.status(400).json({ error: 'Missing user ID' });
  }

  // Security: Non-admin users can only check their own role
  if (targetUserId !== req.user?.id) {
    // Check if current user is admin
    await db.read();
    const currentUserRoles = db.data?.user_roles || [];
    const isCurrentUserAdmin = currentUserRoles.some(
      (r) => r.user_id === req.user?.id && r.role === 'admin'
    );
    
    if (!isCurrentUserAdmin) {
      return res.status(403).json({ error: 'Only admins can check other users\' roles' });
    }
  }

  await db.read();
  const roles = db.data?.user_roles || [];
  const hasRole = roles.some((r) => r.user_id === targetUserId && r.role === _role);
  return res.json(hasRole);
});

router.post('/approve_deposit', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { p_deposit_id, p_admin_id, p_notes } = req.body as {
      p_deposit_id?: string;
      p_admin_id?: string;
      p_notes?: string;
    };

    if (!p_deposit_id || !p_admin_id) {
      return res.status(400).json({ success: false, error: 'Missing deposit_id or admin_id' });
    }

    // Check if current user is admin
    await db.read();
    const currentUserRoles = db.data?.user_roles || [];
    const isAdmin = currentUserRoles.some((r) => r.user_id === req.user?.id && r.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only admins can approve deposits' });
    }

    // Find pending deposit
    const deposits = db.data?.pending_deposits || [];
    const deposit = deposits.find((d) => d.id === p_deposit_id && d.status === 'pending');
    if (!deposit) {
      return res.status(404).json({ success: false, error: 'Deposit not found or already processed' });
    }

    // Get current gas fee balance
    const balances = db.data?.gas_fee_balances || [];
    const existingBalance = balances.find(
      (b) => b.user_id === deposit.user_id && b.environment === deposit.environment
    );

    const balanceBefore = existingBalance?.balance || 0;
    const totalDepositedBefore = existingBalance?.total_deposited || 0;
    const balanceAfter = balanceBefore + deposit.amount;
    const totalDepositedAfter = totalDepositedBefore + deposit.amount;

    // Update or create gas fee balance
    if (existingBalance) {
      existingBalance.balance = balanceAfter;
      existingBalance.total_deposited = totalDepositedAfter;
      existingBalance.updated_at = new Date().toISOString();
    } else {
      db.data?.gas_fee_balances.push({
        id: crypto.randomUUID(),
        user_id: deposit.user_id,
        environment: deposit.environment,
        balance: balanceAfter,
        total_deposited: totalDepositedAfter,
        total_deducted: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      });
    }

    // Record transaction
    db.data?.gas_fee_transactions.push({
      id: crypto.randomUUID(),
      user_id: deposit.user_id,
      amount: deposit.amount,
      transaction_type: 'deposit',
      description: `Deposit approved by admin${p_notes ? ': ' + p_notes : ''}`,
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      environment: deposit.environment,
      created_at: new Date().toISOString(),
    });

    // Update deposit status
    deposit.status = 'approved';
    deposit.admin_notes = p_notes || null;
    deposit.approved_by = p_admin_id;
    deposit.approved_at = new Date().toISOString();

    await safeWrite();

    return res.json({
      success: true,
      message: 'Deposit approved successfully',
      balance_before: balanceBefore,
      balance_after: balanceAfter,
      amount: deposit.amount,
    });
  } catch (error) {
    console.error('Approve deposit error:', error);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

router.post('/reject_deposit', requireAuth, async (req: AuthenticatedRequest, res) => {
  try {
    const { p_deposit_id, p_admin_id, p_notes } = req.body as {
      p_deposit_id?: string;
      p_admin_id?: string;
      p_notes?: string;
    };

    if (!p_deposit_id || !p_admin_id) {
      return res.status(400).json({ success: false, error: 'Missing deposit_id or admin_id' });
    }

    // Check if current user is admin
    await db.read();
    const currentUserRoles = db.data?.user_roles || [];
    const isAdmin = currentUserRoles.some((r) => r.user_id === req.user?.id && r.role === 'admin');
    if (!isAdmin) {
      return res.status(403).json({ success: false, error: 'Only admins can reject deposits' });
    }

    // Find pending deposit
    const deposits = db.data?.pending_deposits || [];
    const deposit = deposits.find((d) => d.id === p_deposit_id && d.status === 'pending');
    if (!deposit) {
      return res.status(404).json({ success: false, error: 'Deposit not found or already processed' });
    }

    // Update deposit status
    deposit.status = 'rejected';
    deposit.admin_notes = p_notes || null;
    deposit.approved_by = p_admin_id;
    deposit.approved_at = new Date().toISOString();

    await safeWrite();

    return res.json({
      success: true,
      message: 'Deposit rejected',
      deposit_id: p_deposit_id,
    });
  } catch (error) {
    console.error('Reject deposit error:', error);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export const rpcRouter = router;

