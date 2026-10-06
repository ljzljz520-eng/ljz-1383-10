'use strict';
const path = require('path');
const express = require('express');
const { createDatabase } = require('./db');
const { createVisibilityService } = require('./services/visibility');
const { createPublishService } = require('./services/publish');
const publicRoutes = require('./routes/public');
const mediaRoutes = require('./routes/media');
const adminRoutes = require('./routes/admin');
const contactRoutes = require('./routes/contact');

async function createApp(opts = {}) {
  const dbPath = opts.dbPath || path.join(__dirname, '..', 'data', 'archive.db');
  const privateDir = opts.privateDir || path.join(__dirname, '..', 'data', 'private');
  const db = await createDatabase(dbPath);
  const vis = createVisibilityService(db, { now: opts.now, ttlMs: opts.ttlMs });
  const publish = createPublishService(db, vis, { now: opts.now });
  const ctx = {
    db, vis, publish, privateDir,
    downloadSecret: opts.downloadSecret || process.env.DOWNLOAD_SECRET || 'dev-download-secret',
  };

  const app = express();
  app.use(express.json({ limit: '8mb' }));

  // 读请求前先执行到点的定时上线（惰性调度，保证读到的状态最新；
  // 写请求不预跑调度，让发布操作自身的冲突检查优先生效）
  app.use('/api', (req, res, next) => { if (req.method === 'GET') publish.runDue(); next(); });

  app.get('/api/health', (req, res) => res.json({ ok: true, time: new Date().toISOString() }));
  app.use('/api', publicRoutes(ctx));
  app.use('/api', mediaRoutes(ctx));
  app.use('/api', contactRoutes(ctx));
  app.use('/api/admin', adminRoutes(ctx));

  app.use(express.static(path.join(__dirname, '..', 'public')));

  // 统一错误处理：业务错误带 status/code，其余 500
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    const status = err.status || 500;
    res.status(status).json({ error: err.code || 'internal_error', message: err.message, details: err.details });
  });

  return { app, db, vis, publish, ctx };
}

module.exports = { createApp };
