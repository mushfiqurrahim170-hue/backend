import { Router } from 'express';
import { db, safeWrite } from '../db/index.js';
import { requireAuth } from '../middleware/auth.js';

const router = Router();

router.post('/', requireAuth, async (req, res) => {
  try {
    const { user_id, action } = req.body as { user_id?: string; action?: 'add' | 'remove' };

    if (!user_id) {
      return res.status(400).json({ success: false, error: 'user_id is required' });
    }

    if (action === 'add') {
      const existingRole = db.data?.user_roles.find((r) => r.user_id === user_id && r.role === 'admin');
      if (existingRole) {
        return res.status(200).json({ success: true, message: 'Admin role already assigned' });
      }
      db.data?.user_roles.push({
        id: crypto.randomUUID(),
        user_id,
        role: 'admin',
        created_at: new Date().toISOString(),
      });
      await safeWrite();

      return res.status(200).json({ success: true, message: 'Admin role assigned' });
    }

    if (action === 'remove') {
      db.data!.user_roles = (db.data?.user_roles || []).filter(
        (role) => !(role.user_id === user_id && role.role === 'admin')
      );
      await safeWrite();

      return res.status(200).json({ success: true, message: 'Admin role removed' });
    }

    return res.status(400).json({ success: false, error: 'Invalid action. Use "add" or "remove"' });
  } catch (error) {
    console.error('Error:', error);
    return res.status(500).json({ success: false, error: 'Internal error' });
  }
});

export const assignAdminRoleRouter = router;

