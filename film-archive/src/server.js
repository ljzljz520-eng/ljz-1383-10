'use strict';
const path = require('path');
const { createApp } = require('./app');
const { seedIfEmpty } = require('./seed');

(async () => {
  const storageDir = path.join(__dirname, '..', 'data', 'storage');
  const { app, db, publish } = await createApp({});
  if (seedIfEmpty(db, storageDir)) console.log('[seed] 演示数据已写入');
  // 定时上线调度器：每 5 秒执行一次到点发布
  setInterval(() => publish.runDue(), 5000).unref();
  const port = Number(process.env.PORT || 3000);
  app.listen(port, () => console.log(`青年导演短片档案 → http://localhost:${port}  (后台 /admin.html)`));
})().catch((e) => { console.error(e); process.exit(1); });
