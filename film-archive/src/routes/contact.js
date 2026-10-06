'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const { httpError, isoNow } = require('../util');

/** 联系表单按类别分流到不同处理队列 */
const ROUTING = {
  collaboration: 'producer-desk',   // 合作 → 制片
  screening: 'programming-desk',    // 放映 → 策展/节目
  interview: 'press-desk',          // 采访 → 媒体宣传
};

module.exports = function contactRoutes(ctx) {
  const { db, privateDir } = ctx;
  const r = express.Router();

  r.post('/contact', (req, res) => {
    const { category, name, email, org = '', message, private_material = null } = req.body || {};
    if (!ROUTING[category]) throw httpError(400, 'invalid_category', 'category ∈ collaboration|screening|interview');
    if (!name || !email || !message) throw httpError(400, 'missing_fields', 'name/email/message 必填');

    // 私密材料：写入公开目录之外的隔离存储，随机文件名，公开接口永不暴露路径
    let materialPath = null;
    if (private_material && private_material.content_base64) {
      fs.mkdirSync(privateDir, { recursive: true });
      materialPath = path.join(privateDir, `${Date.now()}-${crypto.randomBytes(8).toString('hex')}.bin`);
      fs.writeFileSync(materialPath, Buffer.from(private_material.content_base64, 'base64'));
    }

    const id = db.run(
      `INSERT INTO contacts (category, name, email, org, message, routed_to, has_private_material, private_material_path, status, created_at)
       VALUES (?,?,?,?,?,?,?,?, 'new', ?)`,
      [category, name, email, org, message, ROUTING[category], materialPath ? 1 : 0, materialPath, isoNow()]
    );
    res.status(201).json({ id, routed_to: ROUTING[category] });
  });

  return r;
};
