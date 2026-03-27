import type { Request, Response, NextFunction } from 'express';
import '../config/env.js';
import jwt from 'jsonwebtoken';

export interface AuthenticatedRequest extends Request {
  user?: { id: string; email?: string | null };
}

const getJwtSecret = (): string => {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error('Missing JWT_SECRET');
  }
  return secret;
};

export async function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ code: 401, message: 'Unauthorized' });
  }

  const token = authHeader.slice('Bearer '.length);

  try {
    const payload = jwt.verify(token, getJwtSecret()) as { sub: string; email?: string };
    req.user = { id: payload.sub, email: payload.email ?? null };
    return next();
  } catch {
    return res.status(401).json({ code: 401, message: 'Invalid JWT' });
  }
}

