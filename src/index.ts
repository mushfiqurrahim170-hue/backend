import './config/env.js';
import cors from 'cors';
import express from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { registerRoutes } from './routes/index.js';
import { startCronJobs } from './cron.js';
import { initDb } from './db/index.js';

const app = express();
app.use(cors({ origin: true }));
app.use(express.json({ limit: '1mb' }));

app.get('/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

registerRoutes(app);

const port = Number(process.env.PORT || 8080);
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Custom static file serving with fallback for old file structure
app.use('/uploads', async (req, res, next) => {
  const requestedPath = req.path;
  
  // Remove leading /uploads if present
  const cleanPath = requestedPath.startsWith('/') ? requestedPath.slice(1) : requestedPath;

  // Try the exact path first
  const exactPath = path.resolve(__dirname, '../uploads', cleanPath);
  
  const { promises: fs } = await import('node:fs');
  
  try {
    await fs.access(exactPath);
    // File exists at exact path, serve it
    return res.sendFile(exactPath);
  } catch {
    // File doesn't exist at exact path
    // If it's a nested path (e.g., deposit-proofs/user_id/filename), try flat structure
    if (cleanPath.includes('/')) {
      const parts = cleanPath.split('/');
      const bucket = parts[0];
      const filename = parts[parts.length - 1];
      
      // Try flat structure: bucket/filename
      const flatPath = path.resolve(__dirname, '../uploads', bucket, filename);
      
      try {
        await fs.access(flatPath);
        // File exists in flat structure, serve it
        return res.sendFile(flatPath);
      } catch {
        // File doesn't exist in either location
        return res.status(404).json({ error: 'File not found' });
      }
    } else {
      // Not a nested path and file doesn't exist
      return res.status(404).json({ error: 'File not found' });
    }
  }
});

await initDb();

app.listen(port, () => {
  console.log(`Backend listening on port ${port}`);
  startCronJobs(port);
});

