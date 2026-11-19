import 'dotenv/config';
import express from 'express';
import fs from 'node:fs';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { apiRouter } from './server/routes.ts';

const PORT = process.env.NGINX_PORT ? 3000 : Number(process.env.PORT || 3000);

async function startServer() {
  const app = express();
  app.set('trust proxy', 1);

  app.use('/api', (req, res, next) => {
    const origin = req.headers.origin;
    if (origin) {
      res.setHeader('Access-Control-Allow-Origin', origin);
      res.setHeader('Access-Control-Allow-Credentials', 'true');
      res.setHeader('Vary', 'Origin');
    } else {
      res.setHeader('Access-Control-Allow-Origin', '*');
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
    if (req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.use(express.json({ limit: '5mb' }));

  app.get('/api/health', (_req, res) => {
    res.json({ status: 'ok', service: 'autopatch' });
  });

  app.use('/api', apiRouter);

  app.use('/api', (_req, res) => {
    res.status(404).json({ error: 'API endpoint not found.' });
  });

  app.use((err: unknown, req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (res.headersSent) {
      next(err);
      return;
    }
    const errObj = err as { code?: string; status?: number; statusCode?: number; message?: string };
    const isFileTooLarge = errObj?.code === 'LIMIT_FILE_SIZE';
    const msg = isFileTooLarge
      ? 'Uploaded file exceeds the 25 MB limit.'
      : err instanceof Error
        ? err.message
        : 'Internal server error.';
    const status = isFileTooLarge ? 413 : errObj?.status || errObj?.statusCode || 500;
    if (req.path.startsWith('/api')) {
      res.status(status).json({ error: msg });
      return;
    }
    res.status(status).send(msg);
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distDir = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distDir));
    app.get('*', (_req, res) => {
      const indexPath = path.join(distDir, 'index.html');
      if (fs.existsSync(indexPath)) {
        res.sendFile(indexPath);
      } else {
        res.status(404).send('Build output not found.');
      }
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AutoPatch server running at http://0.0.0.0:${PORT}`);
  });
}

startServer();
