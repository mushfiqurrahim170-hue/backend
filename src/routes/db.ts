import { Router } from 'express';
import { requireAuth, type AuthenticatedRequest } from '../middleware/auth.js';
import { db, safeWrite } from '../db/index.js';
import type { Request, Response, NextFunction } from 'express';

const router = Router();

type DbFilter = { op: 'eq' | 'in'; column: string; value: unknown };

const applyFilters = (rows: Record<string, unknown>[], filters: DbFilter[]) => {
  return rows.filter((row) => {
    return filters.every((filter) => {
      const value = row[filter.column];
      if (filter.op === 'eq') {
        return value === filter.value;
      }
      if (filter.op === 'in' && Array.isArray(filter.value)) {
        return filter.value.includes(value as never);
      }
      return true;
    });
  });
};

// Public tables that don't require auth
const PUBLIC_TABLES = ['app_settings'];

const isPublicQuery = (table: string, action: string): boolean => {
  return PUBLIC_TABLES.includes(table) && action === 'select';
};

// Middleware to check if query is public
const checkPublicQuery = (req: Request, res: Response, next: NextFunction) => {
  const { table, action } = req.body as { table?: string; action?: string };
  if (table && action && isPublicQuery(table, action)) {
    // Public query, skip auth
    return next();
  }
  // Require auth
  return requireAuth(req as AuthenticatedRequest, res, next);
};

router.post('/', checkPublicQuery, async (req: Request | AuthenticatedRequest, res: Response) => {
  await handleDbRequest(req, res);
});

async function handleDbRequest(req: Request, res: Response) {
  try {
    const { table, action, filters, order, limit, data, count, head, returning, onConflict } = req.body as {
      table: string;
      action: 'select' | 'insert' | 'update' | 'delete' | 'upsert';
      filters?: DbFilter[];
      order?: { column: string; ascending: boolean };
      limit?: number;
      data?: Record<string, unknown> | Record<string, unknown>[];
      count?: boolean;
      head?: boolean;
      returning?: boolean;
      onConflict?: string;
    };

    if (!table || !action) {
      return res.status(400).json({ error: 'Missing table or action' });
    }

    await db.read();
    const store = (db.data as Record<string, Record<string, unknown>[]>);
    store[table] ||= [];

    if (action === 'select') {
      let rows = applyFilters(store[table], filters || []);
      const totalCount = rows.length;
      if (order?.column) {
        rows = rows.sort((a, b) => {
          const av = a[order.column];
          const bv = b[order.column];
          if (av === bv) return 0;
          if (av === undefined || av === null) return 1;
          if (bv === undefined || bv === null) return -1;
          if (av != null && bv != null && av > bv) return order.ascending ? 1 : -1;
          if (av != null && bv != null && av < bv) return order.ascending ? -1 : 1;
          return 0;
        });
      }
      if (typeof limit === 'number') {
        rows = rows.slice(0, limit);
      }
      const result = head ? [] : rows;
      return res.json({ data: result, count: count ? totalCount : undefined });
    }

    if (action === 'insert') {
      const payload = Array.isArray(data) ? data : [data || {}];
      const inserted = payload.map((row) => ({
        id: row.id || crypto.randomUUID(),
        created_at: new Date().toISOString(),
        ...row,
      })) as Record<string, unknown>[];
      store[table].push(...inserted);
      await safeWrite();
      return res.json({ data: returning ? inserted : null });
    }

    if (action === 'upsert') {
      const payload = Array.isArray(data) ? data : [data || {}];
      const conflictFields = onConflict ? onConflict.split(',').map((s) => s.trim()).filter(Boolean) : [];
      const upserted: Record<string, unknown>[] = [];

      payload.forEach((row) => {
        const match =
          conflictFields.length === 0
            ? undefined
            : store[table].find((existing) =>
                conflictFields.every((field) => existing[field] === row[field])
              );
        if (match) {
          Object.assign(match, row);
          match.updated_at = new Date().toISOString();
          upserted.push(match);
        } else {
          // Set defaults for bot_status if creating new
          const defaults = table === 'bot_status' && !row.id
            ? {
                total_trades: 0,
                successful_trades: 0,
                failed_trades: 0,
                last_trade_at: null,
              }
            : {};
          
          const inserted = {
            id: row.id || crypto.randomUUID(),
            created_at: new Date().toISOString(),
            ...defaults,
            ...row,
          };
          store[table].push(inserted);
          upserted.push(inserted);
        }
      });
      await safeWrite();
      return res.json({ data: returning ? upserted : null });
    }

    if (action === 'update') {
      const rows = applyFilters(store[table], filters || []);
      rows.forEach((row) => {
        Object.assign(row, data || {});
        row.updated_at = new Date().toISOString();
      });
      await safeWrite();
      return res.json({ data: returning ? rows : null });
    }

    if (action === 'delete') {
      const rows = applyFilters(store[table], filters || []);
      store[table] = store[table].filter((row) => !rows.includes(row));
      await safeWrite();
      return res.json({ data: returning ? rows : null });
    }

    return res.status(400).json({ error: 'Unsupported action' });
  } catch (error) {
    return res.status(500).json({ error: error instanceof Error ? error.message : 'Unknown error' });
  }
}

export const dbRouter = router;

