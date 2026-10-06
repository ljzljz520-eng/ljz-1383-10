# 青年导演短片档案（Youth Short Film Archive）

Web 展示海报 / 剧照 / 放映记录；后台接口与数据库管理剪辑版本、公开片段、许可与合作申请。

## 运行

```bash
npm install
npm start          # http://localhost:3000 （后台 /admin.html，演示令牌 token-admin-a / token-admin-b）
npm test           # 11 项验收测试
```

首次启动自动写入演示数据（`data/archive.db`，sql.js / SQLite WASM，随写落盘）。

## 核心设计

### 1. 放映记录绑定实际版本，不按片名合并
`screenings.version_id → versions.id` 外键强约束。一部影片可有影展版 / 公开版 / 导演版
（`versions.label ∈ festival|public|director`），公开详情按版本分组呈现放映记录；
补录历史场次时 `version_id` 必填且必须存在，否则 404。

### 2. 许可三维范围 + 分素材类型检查
`licenses(asset_kind, territory, media, starts_at, ends_at, status)`：
- 预告、剧照、完整影片（及海报、公开片段）**各自独立授权、独立检查**；
- 地域：`GLOBAL` 或地区码（请求带 `?region=CN`）；媒介：`web|festival|broadcast|all`；
- 素材可见性 = 许可有效 ∧ 版本已发布到 `web_public` 槽位（影展线版本不在 web 泄露）
  ∧ 公开片段需管理员显式批准（`is_public_clip`）。

### 3. 可见性方案：实时许可计算（选型结论）
| 方案 | 优点 | 缺点 |
|---|---|---|
| A. 按许可实时计算 | 授权提前结束立即生效；单一权威 | 每次请求需计算 |
| B. 预先批准发布清单 | 缓存友好、可审计 | 授权终止后清单不失效，存在越权窗口 |

**选择 A 为唯一权威**，叠加两项工程措施：
- **短 TTL 缓存 + 事件驱动失效**：任何许可/版本/素材写操作按影片主动清缓存，
  授权提前结束**不等待 TTL** 立即生效；
- **到期缓存**：缓存条目过期时间取 `min(TTL, 最近许可 ends_at / 下一条许可 starts_at)`，
  缓存绝不比许可活得更久，也不会因缓存否定结果而错过许可生效时刻。

方案 B 保留为**发布流程**（槽位 + 定时上线），只决定"哪个版本上线"，可见性仍由许可把关。

### 4. 发布冲突与定时上线
- 同一影片同一槽位（`web_public` / `festival_circuit`）同一时刻仅一个已发布版本；
- 两个管理员发布不同剪辑 → 后到者 **409 publish_conflict**；`force=true` 显式替换并归档旧版；
- 定时上线：**排期时预检**与已发布/已排期版本的冲突（409 拒绝）；
  **执行期复查**，若槽位被抢占则标记 `schedule_failed`，绝不静默覆盖他人发布；
- 全部动作写入 `publish_events` 审计（含 conflict_rejected）。

### 5. 不可公开时的降级与探测接口安全
- 影片无法公开时，公开接口下发 `films.fallback_text`（**经批准的文字说明**）；
- 媒体探测 `GET /api/media/:id/probe` 只返回可用性元数据；
  不可见时 404 + 批准文案，**任何响应都不含存储路径或原文件地址**；
- 文件流 `/api/media/:id/file` 内部读取存储转发，`Cache-Control: no-store`，每次请求实时复查许可。

### 6. 下载权限变更
`POST /api/media/:id/download-token`（管理员）签发 60 秒 HMAC 令牌；
`GET /api/download/:token` 验签 + 过期检查 + **许可实时复查**——
令牌签发后授权被提前结束，下载返回 403 `permission_revoked`。

### 7. 联系表单分流与私密材料隔离
`POST /api/contact` 按类别分流：合作→制片（producer-desk）、放映→策展（programming-desk）、
采访→宣传（press-desk）。私密材料存于公开目录之外的隔离存储（随机文件名），
仅管理员经认证接口 `GET /api/admin/contacts/:id/material` 读取；列表接口绝不返回材料路径。

### 8. 搜索与详情一致 / 署名不夸大
- 列表与详情共用同一序列化器与可见性逻辑，同名字段必然一致（有测试保证）；
- 署名按来源原文记录、带 `verified` 核实标记；同一人的不同职责保留为独立记录，
  系统不做任何自动升格、合并或推断。

## 验收场景（tests/acceptance.test.js，11 项全绿）

1. **字幕修订**：修订号递增，公开详情反映，既有放映记录不受影响；
2. **展映记录补录**：历史场次挂到实际版本，同片名不同剪辑不合并；
3. **授权提前结束**：缓存主动失效，探测立即 404 + 批准文案、无路径泄露；
4. **两个管理员发布不同剪辑**：409 → force 替换 → 旧版归档，全程审计；
5. **请求下载时权限变更**：令牌签发后终止许可，下载 403；
6. 定时上线：排期冲突预检 409；执行期被抢占则 schedule_failed 不覆盖；
7. 到期缓存：缓存过期时间不超过许可 ends_at；
8. 公开搜索与详情逐字段一致；
9. 联系表单三分流 + 私密材料隔离（未认证 401、列表无路径）；
10. 署名原文保留、核实标记、不自动升格；
11. 许可按地域/媒介/素材类型分别检查。

## API 概览

公开：`GET /api/films?query&region` · `GET /api/films/:id` · `GET /api/films/:id/screenings`
· `GET /api/media/:id/probe` · `GET /api/media/:id/file` · `POST /api/contact`

后台（`X-Admin-Token`）：`POST /api/admin/films` · `POST /api/admin/films/:id/versions`
· `POST /api/admin/versions/:id/publish|unpublish|subtitle-revision` · `POST /api/admin/assets`
· `POST /api/admin/licenses` · `POST /api/admin/licenses/:id/terminate`
· `POST /api/admin/screenings` · `POST /api/admin/credits`
· `GET /api/admin/contacts` · `GET /api/admin/contacts/:id/material`
· `GET /api/admin/publish-events` · `POST /api/admin/scheduler/run`
· `POST /api/media/:id/download-token` → `GET /api/download/:token`
