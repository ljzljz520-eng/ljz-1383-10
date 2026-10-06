# 青年导演短片档案

短片档案系统：Web 展示海报/剧照/放映记录，后台管理剪辑版本、公开片段与合作申请。

## 运行

```bash
npm install
node src/seed.js     # 可选：写入演示数据
npm start            # http://localhost:3000
npm test             # 34 项验收测试
```

- 公开档案：`/index.html`（搜索、海报、按地区可见性）
- 影片详情：`/film.html?id=1`（媒介分区、字幕修订、署名、放映记录、联系表单）
- 后台：`/admin.html`（令牌 `token-admin-a` / `token-admin-b`，模拟两名管理员）

## 核心设计决策

### 可见性：按许可实时计算（选定） vs 预先批准发布清单（仅作门控）

| 维度 | 实时许可计算（选定） | 预批准发布清单 |
|---|---|---|
| 授权提前结束 | **立即生效**（每次判定都查许可当前状态） | 清单已发出即失真，需召回机制，存在泄漏窗口 |
| 地域/时段/媒介粒度 | 天然支持逐次请求判定 | 需为每个维度组合预生成清单，爆炸式增长 |
| 性能 | 需缓存兜底 | 读时 O(1) |
| 定时上线 | 作为时间边界参与计算，无需 cron | 需 cron 到点翻转状态，存在竞态 |

**结论**：以「按许可实时计算」为可见性**权威真源**；发布清单降级为**必要门控条件之一**
（版本必须已批准且到达 `not_before` 才有资格可见），而非真源本身——兼顾防御纵深与正确性。

**到期缓存处理**（`src/cache.js`）：
- **纪元失效**：任何许可/版本/清单/资产变更 `bumpEpoch()`，全部缓存条目立即作废 → 授权提前结束零延迟生效；
- **边界 TTL**：条目过期时间取 `min(30s, 距下一状态翻转点)`，翻转点 = 许可起止时间与定时上线时刻 → 到点自动重算，不依赖 cron 主动刷新。

**定时上线冲突处理**：定时上线建模为发布清单上的 `not_before` **门控**（计算式），
而不是 cron 到点翻转 `published` 状态。因此：
1. 不存在 cron 与管理员手动操作的写冲突——根本没有第二个写者；
2. 到达 `not_before` 只代表"有资格"，仍需版本处于 `published`；
3. 发布动作走事务 + 部分唯一索引 `one_published_version_per_film`，
   两名管理员同时发布不同剪辑时后到者收到 **409**，必须显式 `supersede` 才能原子替换。

### 版本与放映记录

- 影片可有影展版/公开版/导演版（`versions.label` + `seq` 支持同类型多次剪辑）；
- 放映记录**强制绑定 version_id**，且校验版本必须属于该影片（422），同名片不同剪辑绝不合并；
- 字幕修订 = 同版本下 `revision+1` 的新资产行，旧修订保留可回溯，公开端永远取最新修订。

### 许可模型

- 按媒介分别授权：海报/剧照/预告/公开片段/完整影片/字幕各自独立检查；
- 每条许可含地域列表（`["WORLD"]` 或具体地区）、起止时段、状态；
- 提前终止：`status=terminated` + 审计，缓存纪元失效使其立即生效。

### 安全

- **媒体探测接口**（`/api/media/probe`）只返回可用性与原因码，可用时也仅返回"申请下载"端点，
  **绝不返回原始文件地址**；
- 下载链路：`POST request-download`（实时判定许可）→ 60 秒短时效令牌 →
  `GET stream` **在下载开始时再次实时复核许可** → 令牌签发后权限被收回，下载仍被拒（403）；
- 影片无法公开时返回**经批准的文字说明**（`fallback_approved=1` 才展示）；
- 联系表单按 合作/放映/采访 分流入库，`private_material` 仅管理员队列接口可见，
  提交回执不回显，公开侧无任何读取接口；
- 署名单独存 `role` 原文 + `verified` + `source`：可核实职责原样展示（"摄影助理"不会变成"摄影指导"），
  声称已核实必须附来源；
- 搜索与详情共用同一 `buildFilmView()` 判定路径，保证两处可见性一致。

## API 摘要

公开：`GET /api/films` · `GET /api/films/:id` · `GET /api/media/probe` ·
`POST /api/media/:id/request-download` · `GET /api/media/stream?token=` · `POST /api/contact`

后台（`x-admin-token`）：`POST /api/admin/films|versions|assets|licenses|screenings|release-list` ·
`POST /api/admin/versions/:id/publish` · `POST /api/admin/licenses/:id/terminate` ·
`POST /api/admin/assets/:id/revise` · `GET /api/admin/contacts?category=` · `GET /api/admin/audit`

## 验收场景（test/acceptance.test.js，34 项断言）

1. **字幕修订**：新修订即时生效，旧修订保留；
2. **展映记录补录**：绑定实际版本、跨影片绑定被拒；
3. **授权提前结束**：探测/详情/下载立即失效，展示批准说明；
4. **双管理员发布不同剪辑**：后到者 409，supersede 原子替换，双方留审计；
5. **请求下载时权限变更**：下载开始时复核许可，403 拒绝；
6. 媒体探测不泄漏文件地址；7. 表单分流与私密材料隔离；8. 搜索/详情一致、定时上线门控、署名不夸大。
