import type { Express } from 'express';
import { exchangeApiRouter } from './exchangeApi.js';
import { assignAdminRoleRouter } from './assignAdminRole.js';
import { tradingviewWebhookRouter } from './tradingviewWebhook.js';
import { autoSignalGeneratorRouter } from './autoSignalGenerator.js';
import { positionMonitorRouter } from './positionMonitor.js';
import { authRouter } from './auth.js';
import { exchangeRouter } from './exchange.js';
import { webhookRouter } from './webhook.js';
import { strategiesRouter } from './strategies.js';
import { dbRouter } from './db.js';
import { rpcRouter } from './rpc.js';
import { uploadsRouter } from './uploads.js';

export function registerRoutes(app: Express) {
  app.use('/api/auth', authRouter);
  app.use('/api/db', dbRouter);
  app.use('/api/rpc', rpcRouter);
  app.use('/api/uploads', uploadsRouter);
  app.use('/api/webhook', webhookRouter);
  app.use('/api/exchange', exchangeRouter);
  app.use('/api/strategies', strategiesRouter);
  app.use('/api/exchange-api', exchangeApiRouter);
  app.use('/api/assign-admin-role', assignAdminRoleRouter);
  app.use('/api/tradingview-webhook', tradingviewWebhookRouter);
  app.use('/api/auto-signal-generator', autoSignalGeneratorRouter);
  app.use('/api/position-monitor', positionMonitorRouter);
}

