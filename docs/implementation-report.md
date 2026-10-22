# 知簇实现报告

2026-10-22，版本 0.1.0。从任务书单文件初始化为 React/TypeScript 前端、FastAPI 后端、独立 worker、PostgreSQL/pgvector、LangChain/LangGraph 的可运行知识工作区。

## 功能矩阵

| 阶段 | 已实现功能 | 状态 / 验证边界 |
| --- | --- | --- |
| M0 | monorepo、uv/pnpm lock、Compose 生产/开发、迁移、settings、健康检查、默认身份/KB | 完成；生产全栈启动与真实热更新通过 |
| M1 | 四区中文界面、明暗主题、响应式/折叠/宽度持久化；KB/多级文件夹/标签管理；多文件上传、去重、批量操作、回收站、下载和阅读器 | 完成；真实生产浏览器主流程、拖放批量及来源定位验收通过 |
| M2 | 四格式解析与锚点、token 分块、后台队列租约/心跳/恢复、独立向量 profile、批次续传、预算内层级摘要、分类建议与人工应用 | 完成实现；真实文件和 PG 测试通过，云端质量因 Key 受阻 |
| M3 | pg_trgm/ILIKE + 精确 cosine + RRF、范围过滤；持久会话、token SSE、引用白名单和位置阅读 | 完成实现；假模型协议/真实来源/SQL 已测，真模型回答质量未测 |
| M4 | create_agent 只读工具规划、结构化计划、LangGraph interrupt、PG checkpoint、编辑整批审批、高风险确认、事务/幂等/审计/撤销 | 完成实现；真实 PG 并发与独立进程恢复通过，真模型规划未测 |
| M5 | 自动化测试、可执行 HTTP smoke、部署/备份文档、安全审查和验收矩阵 | 完成；实际执行结果见 acceptance |

## 实现决策

- SQLAlchemy 同步 Session 简化事务与 worker 集成；FastAPI 同步路由运行在线程池，事务在响应发出前提交，SSE 使用独立短会话。没有另建 Redis/Celery 服务。
- PostgreSQL 保存任务、结果、审批、事件和审计。LangGraph checkpoint 放专用 schema，只存工作流恢复状态，业务 undo 独立保存。
- `vector` 不固定维度，profile 记录 provider URL/model/dimension 的无密钥指纹；先做精确 cosine，未启用 HNSW。小规模 Demo 正确性优先，大规模性能需要后续基准。
- AI 子阶段独立：无 Key 或模型失败时本地解析和关键词搜索保持可用。正常路径没有 fake 摘要、fake 向量或 fake Agent 计划。
- 文档原件存私有卷、服务器生成路径；跨库关联由权限服务和复合外键双重检查。首版禁止跨库 Agent 移动，避免未设计的授权语义。
- UI 使用 Radix primitives/shadcn 风格局部组件和 Tailwind tokens；Markdown 安全预览；PDF 使用本地 PDF.js canvas 渲染、页跳转与片段提示，worker/CMap/字体/WASM 均在本地提供，未加入 OCR 或 PDF 精确字符级标注。

## 启动和环境变量

根目录先在 `.env` 不存在时复制 `.env.example`，然后 `docker compose up --build -d`，访问 http://localhost:3000；OpenAPI 在 http://localhost:8000/docs。当前交付已创建不含密钥的本地 `.env`，生产服务保留运行。完整说明见 README。

需要填写 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL` 与独立的 `EMBEDDING_BASE_URL`、`EMBEDDING_API_KEY`、`EMBEDDING_MODEL`、`EMBEDDING_DIMENSION`。模型必须实际支持相应接口；设置页能分别测试聊天、Embedding 和 Tool Calling。配置后重启 api/worker，并给旧文档重试 AI 阶段或重建向量索引。

## 已知边界与优先级

1. **P1：真实云端联调**。当前未提供凭据，未进行付费模型调用。需要验证提供方工具调用、长文摘要成本、分类与中文语义召回，以及真实 RAG 引用质量。确定性 fake 测试不能替代此验收。
2. **P2：规模与长时压力验收**。当前以本地 Demo 和小规模精确向量检索为目标；未做 500 页真实云端处理或万级文档并发基准。后续按实际 profile 加维度适配的近似索引和更细粒度 worker 并发控制。
3. **P2：阅读与体验深化**。PDF.js 已真实渲染目标页并显示来源片段；未实现 PDF 字形级高亮。DOCX 定位到真实段落而不是页。可继续完善复杂长文的目录和定位体验。

明确不做：登录注册/共享成员 UI、OCR、PPTX/Excel/音视频/网页抓取、知识图谱、任意代码执行 Agent 工具、永久删除原件。生产公开使用前必须补认证。

网络调用已成功而本地提交前崩溃时，通用 OpenAI 兼容 API 没有统一计费幂等保证，重试可能再次计费。已提交的向量批次会被复用，避免常规重试整篇重算。

实际测试、部署和浏览器结果见 [acceptance.md](acceptance.md)。已完成项目以可执行证据为准；BLOCKED 的云端项没有计入通过项。

最终实测：后端 **74 PASS**（含真实 PostgreSQL 专库、并发、恢复、权限与事务）；前端 Vitest **8 PASS**；生产 Chromium E2E **3 PASS**；开发热更新 **19 PASS**；TS/ESLint/build/Ruff、完整 Compose、新库迁移、真实四格式 HTTP smoke 和重启持久化均 PASS。没有未修复的已知验收失败；真实云端及规模性能项按上文边界保留 BLOCKED/NOT_RUN。
