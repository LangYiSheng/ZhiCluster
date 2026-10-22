# 验收记录

日期：2026-10-22。状态只使用 PASS / FAIL / NOT_RUN / BLOCKED。fake provider 仅用于自动化测试，正常应用没有演示 AI 返回值。

## 执行环境与命令

- Windows PowerShell；Node 22.19.0；pnpm 11.25.0；uv 0.11.8；Python 3.12.13；Docker Desktop 4.47.0 / Engine 28.4.0。
- 从仅含任务书的目录初始化 Git、前后端和依赖锁。`uv sync --project backend --python 3.12`、`pnpm install --frozen-lockfile` 实际执行成功。
- `docker compose up db -d`：PASS。首次 5432 与本机服务冲突，已修正项目默认回环端口为 55432，再次启动成功。
- 新库 `alembic upgrade head` + `python -m app.db.seed` + `python -m app.agent.graph --setup`：PASS。复合外键自动迁移顺序错误已修复，独立测试库从空库迁移成功。
- `backend/.venv/Scripts/ruff check app tests`：PASS。
- 最终全后端测试（开启两个 PostgreSQL 专库）：`74 passed in 33.03s`，没有跳过项。
- 入库专项：`33 passed in 12.14s`（8 项真实 PostgreSQL）；Agent 专项：`18 passed in 11.02s`（4 项真实 PostgreSQL、2 项 HTTP/SSE）。专项数量是全集的子集，不能与全集相加。
- 前端 `pnpm typecheck`、`pnpm lint`、`pnpm build`：PASS；`pnpm test`：8 PASS。
- `docker compose up --build -d`：PASS。四个常驻服务运行、API/DB healthy；迁移任务成功退出。最终镜像含本地 PDF.js、Agent 取消、上传安全和事务提交修复。
- `pwsh -NoProfile -File scripts/verify-dev.ps1 -Runtime`：19 PASS，退出码 0，实际 CSS HMR 与 API/worker 重载均通过。
- 真实 Chromium E2E（最终 Docker 生产服务）：`3 passed (23.2s)`，包含 PDF.js 实际像素、MD/DOCX 定位、XSS、DataTransfer 多文件上传与文档/目录拖放、批量操作、循环拒绝和筛选排序。

完整后端命令（backend 目录，测试使用专库）：

```powershell
$env:DATABASE_URL='sqlite://'
$env:PG_INGESTION_TEST_URL='postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster_ingestion_test'
$env:ZHICLUSTER_TEST_DATABASE_URL='postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster_agent_test'
.venv/Scripts/ruff check app tests
.venv/Scripts/python -m pytest -q -p no:cacheprovider --basetemp ../.test-tmp-final
```

两个专库用于可重复集成测试，主库 `zhicluster` 从未清空。未显式配置测试库时 PostgreSQL 项标记 SKIPPED，不计为 PASS。

## 任务书 14.1：无 Key 验收

| 验收项 | 状态 | 实际证据 / 边界 |
| --- | --- | --- |
| 生产 Compose 站点、健康检查 | PASS | `docker compose up --build -d`、`docker compose ps`；web 3000/API 8000/DB 55432 全部回环绑定 |
| 开发前后端及 worker 热更新 | PASS | 19 项实际 Runtime 检查，CSS 保留内存 sentinel，API PID 和 worker identity 改变 |
| demo 用户、初始知识库与迁移幂等 | PASS | seed 连续执行，真实主库与两个测试库 |
| 重启保留 KB、文件夹、标签及原件 | PASS | `docker compose restart db api worker web` 后 smoke --verify；4 份下载文件 SHA256 与目录关系保持 |
| 两库、多级文件夹、标签、知识隔离 | PASS | `test_library_api`、真实 PG 检索测试 |
| PDF/DOCX/MD/TXT 正文与来源锚点 | PASS | 真实生成 PDF/DOCX、中文 MD/TXT，解析+SQL持久化+检索 |
| 无文本层 PDF 明确失败 | PASS | parser 与 PostgreSQL pipeline 测试 |
| 重复上传、保留副本、非法格式、危险文件名 | PASS | API 四格式主流程及拒绝测试 |
| 超限文件 | PASS | `test_upload_size_and_mime_limits`：超单文件上限、声明超批次大小、MIME 不一致均拒绝；ASGI 在 multipart spool 前限制总读取字节 |
| 任务失败、重试、租约恢复、旧 worker 写入阻止 | PASS | SQLite 状态机和真实 PostgreSQL 双连接测试 |
| 右键、移动/打标/删除/恢复、CtrlK、主题、响应式 | PASS | 真实 Chromium UI→API→DB→worker→阅读器主流程 |
| 实际拖放上传/目录移动、批量复选、筛选/排序 | PASS | 最终生产第 3 条 Chromium 流程：DataTransfer 2 个 TXT，复选批量打标、真实 dragTo 后 API 核对关系，目录嵌套与循环拒绝，pdf/txt 筛选和名称排序 |
| 中文文件名及中文片段关键词命中、无向量明确降级 | PASS | SQLite API + PostgreSQL pg_trgm/ILIKE |
| 跨库 folder/tag、越权 KB、非法文件夹子树、删除资源拒绝 | PASS | API、Agent、PostgreSQL 检索测试；DB 复合外键提供第二道校验 |
| Agent 结构、编辑参数、一次批准、幂等、冲突、审计、撤销 | PASS | 真正 create_agent + fake model；SQLite 与真实 PostgreSQL |
| SSE 格式、事件游标、Last-Event-ID 与结果恢复 | PASS | Agent HTTP/SSE、聊天 token/citation 完成与游标重放测试 |
| TS/ESLint/build/Ruff/Pytest/全新库 migration | PASS | 实际命令执行，最终计数见末尾 |

## 任务书 14.2：真实云端验收

| 验收项 | 状态 | 原因 |
| --- | --- | --- |
| 独立聊天/Embedding/Tool Calling 联网探测 | BLOCKED | 未提供真实 API Key；无 Key 返回明确错误已测 |
| 长文档真实向量、章节/全文摘要、分类建议质量 | BLOCKED | 算法、预算和持久化通过 fake provider 测试，未冒充云端质量 |
| 已有标签匹配、编辑建议并应用真实模型产物 | BLOCKED | 规则归一化及应用服务已实现，真实模型产物尚未获取 |
| 真正语义 hybrid search 多范围过滤 | BLOCKED | 真实 pgvector + 可控向量已验证，真实 Embedding 召回质量未测 |
| 云模型 RAG 回答、真实引用与位置跳转 | BLOCKED | 真实文件→片段→citation 白名单→阅读器已测，LLM 联网生成未测 |
| 自然语言整理→只读工具→编辑→批准 | BLOCKED | 状态机真实运行并由 fake model 验证，真实云模型规划质量未测 |
| 真模型拒绝/高风险确认/审计/撤销/重启恢复 | BLOCKED | 对应确定性工作流和真实 PostgreSQL 恢复已 PASS，未进行真模型验收 |

## 任务书 14.3：数据和安全

| 验收项 | 状态 | 证据 |
| --- | --- | --- |
| .env 忽略、密钥无 API/bundle 输出、回环绑定 | PASS | `.gitignore`、配置输出 schema、Compose 端口、模型适配错误脱敏 |
| 非 local/test 部署拒绝启动、Host/Origin 限制 | PASS | main 启动保护与 HTTP 拒绝测试；公网认证未开发 |
| 检索 SQL 在查询前限制 KB/profile/删除可见性 | PASS | `scoped_query` 与真实 `<=>` 查询；不存在先跨库 TopK 后 Python 过滤 |
| 下载/全文/Agent read tools 权限检查 | PASS | 统一 permissions 服务和拒绝测试 |
| 私有存储、路径遍历、签名、DOCX 解压/宏与二进制文本检查 | PASS | 上传 API 与 parser 安全测试 |
| Markdown HTML/XSS 防护 | PASS | react-markdown skipHtml，默认 URL 清理，不执行文档代码 |
| 资料作为不可信数据，LLM 无业务写工具 | PASS | RAG source_data 放独立数据消息；Agent 只读工具/结构化执行边界 |
| 元数据更改不重解析/重算向量，模型维度隔离 | PASS | SQLite 与真实 PostgreSQL profile 切换测试 |
| 审批前零业务写，所有 Agent 副作用审计和软删除恢复 | PASS | 拒绝前后快照、审计、UndoRecord 与原件保留测试 |

## 发现并修复的问题

1. 沙箱运行时无法创建进程，转为经过自动批准的本地命令执行；嵌入浏览器运行时同样不可用，改用真实 Chromium Playwright 验收。
2. 5432 端口冲突改用项目专用 55432；没有终止或修改原有数据库。
3. Alembic 复合外键依赖顺序修正为先全部唯一约束、后外键；新库重新验收。
4. Agent 行锁后 ORM identity map 可能保留旧状态，已刷新并加真实并发审批测试；同 thread 使用 PostgreSQL advisory lock。
5. 聊天与入库模型返回后重新检查租约，避免旧 worker 保存结果；空流与流中断明确失败。
6. DOCX 不生成页码，PDF 无文本层明确失败；Embedding 维度和有限数值在写入前校验。
7. Windows Docker bind mount 文件事件未送达；开发 override 启用 watchfiles/chokidar polling 后，19 项热更新 Runtime 检查通过。
8. 原生 PDF 插件在浏览器验收中显示空灰色，改用本地 PDF.js canvas；真实第 2 页墨色像素、文本 marker 与页码通过断言。
9. SSE 连接持续鉴权，已删除来源在事件重放时遮蔽；空会话范围拒绝；聊天恢复清理旧引用，Agent 规划取消/失租均有真实 PostgreSQL 回归。
10. 依当前 FastAPI 官方文档改为 function scope 提交事务；模拟 commit 失败的 HTTP 请求返回 409 且没有持久化，不会提前发送成功。
11. 最终生产回归发现 `.mjs` 默认 MIME 为 application/octet-stream；Nginx 改为 application/javascript 后 PDF.js worker 加载和页面像素通过。新建子目录误带父级 version 导致 422，修正请求字段并验证成功。

## 最终部署复测

- 最终 backend：`74 passed in 33.03s`，Ruff `All checks passed!`。
- 最终完整镜像：`docker compose up --build -d --force-recreate api worker web migrate`，退出码 0；迁移成功，四服务运行。生产不包含开发 polling 或源码挂载。
- 生产 HTTP smoke：`backend/.venv/Scripts/python scripts/smoke.py` → `PASS, documents=4, keyword_hits=3, mode=keyword`；经过真实 Nginx/API/独立 worker/PostgreSQL/私有卷。
- 持久化：四服务 restart 后，`scripts/smoke.py --verify` → `PASS, documents=4`；最终生产重建后再次 verify 通过。
- 开发：`scripts/verify-dev.ps1 -Runtime` → 19 PASS；探针全部清理，现已恢复生产模式。
- 最终生产 Chromium：`pnpm test:e2e` → `3 passed (23.2s)`；主流程 10.3s、PDF/DOCX 4.8s、拖放/批量/目录安全 5.6s。前端 `pnpm test` → 8 passed；typecheck/lint/build 全 PASS。
- 浏览器证据：[亮色](evidence/workspace-light-1440.png)、[暗色](evidence/workspace-dark-1440.png)、[900px](evidence/workspace-tablet-900.png)、[390px](evidence/workspace-mobile-390.png)、[PDF 第2页](evidence/pdf-source-page-2.png)、[DOCX 段落](evidence/docx-source-paragraph.png)。
- 尚未执行真实云端调用、500 页云端摘要和万级文档性能基准；相应项保留 BLOCKED / NOT_RUN，不计入通过数。
