import { Router, type Request } from 'express';
import type { Request as ExpressRequest } from 'express';
import multer from 'multer';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { requireAuth } from '../middleware/auth.js';
import crypto from 'node:crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const router = Router();

const storage = multer.diskStorage({
  destination: async (req: ExpressRequest, _file: Express.Multer.File, cb: (error: Error | null, destination: string) => void) => {
    const bucket = req.params.bucket || 'uploads';
    const requestedPath = req.body.path as string | undefined;
    
    // If path includes nested structure (e.g., "user_id/filename"), extract the directory part
    let dest: string;
    if (requestedPath && requestedPath.includes('/')) {
      const pathParts = requestedPath.split('/');
      const dirPart = pathParts.slice(0, -1).join('/'); // Everything except the filename
      dest = path.resolve(__dirname, '../../uploads', bucket, dirPart);
    } else {
      dest = path.resolve(__dirname, '../../uploads', bucket);
    }
    
    await fs.mkdir(dest, { recursive: true });
    cb(null, dest);
  },
  filename: (req: ExpressRequest, file: Express.Multer.File, cb: (error: Error | null, filename: string) => void) => {
    const requestedPath = req.body.path as string | undefined;
    const fallback = `${crypto.randomUUID()}-${file.originalname}`;
    
    if (requestedPath) {
      // Extract just the filename part (last segment after /)
      const filename = requestedPath.includes('/') 
        ? requestedPath.split('/').pop() || fallback
        : requestedPath.replace(/^\/*/, '');
      cb(null, filename);
    } else {
      cb(null, fallback);
    }
  },
});

const upload = multer({ storage });

router.post('/:bucket', requireAuth, upload.single('file'), (req: Request & { file?: Express.Multer.File }, res) => {
  const bucket = req.params.bucket || 'uploads';
  const filePath = req.body.path || req.file?.filename;
  if (!filePath || !req.file) {
    return res.status(400).json({ error: 'Missing file or file path' });
  }

  // Return the relative path that will be served by static middleware
  // The path should be: bucket/filename
  const relativePath = `${bucket}/${filePath}`;
  const publicUrl = `${process.env.BACKEND_URL || 'http://localhost:8080'}/uploads/${relativePath}`;

  return res.json({
    path: filePath,
    bucket,
    publicUrl,
  });
});

export const uploadsRouter = router;

