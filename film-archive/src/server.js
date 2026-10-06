'use strict';
const express = require('express');
const path = require('path');
const { initDb } = require('./db');

function createApp(db) {
  const app = express();
  app.use(express.json());
  app.use('/api', require('./routes/public')(db));
  app.use('/api/admin', require('./routes/admin')(db));
  app.use(express.static(path.join(__dirname, '..', 'public')));
  app.use((req, res) => res.status(404).json({ error: 'not_found' }));
  // 统一错误处理：不向客户端泄漏内部细节
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[server-error]', err.message);
    res.status(500).json({ error: 'internal_error' });
  });
  return app;
}

async function start() {
  const db = await initDb();
  const app = createApp(db);
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`青年导演短片档案 → http://localhost:${port}`));
}

if (require.main === module) start();

module.exports = { createApp };
