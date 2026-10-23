# 知簇 · ZhiCluster

本地优先知识工作区：管理真实文件，按范围检索资料，通过带引用的多轮问答串联知识。

## 一键启动

前置条件：Docker Desktop（Linux containers）、Docker Compose 2.24.4+。源码开发另需 Node.js 22.12+、pnpm 11、uv 与 Python 3.12。

```powershell
if (-not (Test-Path .env)) { Copy-Item .env.example .env }
docker compose up --build -d
docker compose ps
```

打开 **http://localhost:3000**；API 文档 **http://localhost:8000/docs**。默认建立本地用户和“我的知识库”。不需要 Key 即可上传、解析、阅读、下载、管理文件夹/标签，及使用中文关键词搜索。AI 阶段会明确显示“未配置”，不会伪造结果。

全部宿主机端口绑定 `127.0.0.1`。数据库默认端口 `55432`（可在 `.env` 修改 `POSTGRES_PORT`）。这是免登录单用户 Demo；`APP_ENV` 使用非 local/test 值会拒绝启动。公开部署前必须实现认证，不应直接改端口到公网。

## 网页设置与模型连接

打开左侧「设置」，按「外观与布局 / 模型连接 / 知识处理 / 索引维护」配置。各页使用统一分组卡片；聊天与向量连接分别配置和测试。外观保存于当前浏览器，模型连接和处理参数保存于后端数据库。先用对应的连接测试检查草稿，再点「保存修改」。测试不会自动保存，也不会同时调用其它模型。

密钥输入框始终为空：留空保留已保存的密钥，填写新值替换，勾选「保存时清除现有密钥」才会清除。后端加密保存密钥，不向浏览器返回原值。多窗口编辑发生冲突时会保留草稿并提示重新读取。离开未保存的设置会询问是否放弃；返回工作区会保留聊天草稿和正在运行的对话。

保存后，API 的后续请求和 worker 下一次领取的任务自动采用新配置，**无需重启服务**；执行中的任务使用开始时的快照，任务重试时重新读取配置。更改向量模型、服务地址或维度后，到「索引维护」选择知识库并重建已有索引。

也可在首次启动前用 `.env` 提供初始默认值：

```dotenv
LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=your-secret
LLM_MODEL=your-chat-model
EMBEDDING_BASE_URL=https://your-embedding-provider.example/v1
EMBEDDING_API_KEY=your-other-secret
EMBEDDING_MODEL=your-embedding-model
EMBEDDING_DIMENSION=实际返回维度
```

BASE_URL 填写服务方实际 API 前缀（常见为 `/v1`），不包含 `/chat/completions` 或 `/embeddings`。两个服务可来自不同提供方。`EMBEDDING_DIMENSION` 必须与真实返回长度一致，示例 1024 不代表任何厂商默认值。密钥仅在后端，不能写入前端环境变量。

目前接入的是 **OpenAI 兼容 HTTP API**，不能直接导入 GGUF、safetensors 等权重文件。本地模型需先由推理服务提供兼容接口。服务地址填写提供方实际前缀，例如 `https://api.example.com/v1`；程序自动追加下表路径，密钥通过 `Authorization: Bearer ...` 发送。

| 用途 | 接口及必要能力 | 数据格式 |
| --- | --- | --- |
| 聊天、知识问答 | `POST /chat/completions`，支持普通文本与 `stream: true` 的 SSE | 请求 `model`、`messages`；普通响应读取 `choices[0].message.content`，流响应读取 `choices[0].delta.content` |
| 摘要、分类建议 | 同一聊天接口，额外支持 `response_format: {"type":"json_object"}` | 返回可解析的 JSON 文本；非流式请求还会发送 `temperature`、`max_tokens` |
| 向量检索 | `POST /embeddings`，支持批量文本输入 | 请求 `model`、`input: string[]`；响应 `data: [{index, embedding: number[]}]`，维度必须与设置一致 |

仅提供 Responses、Anthropic Messages 或 Gemini 原生协议的服务，目前需要先通过兼容转换层。连接测试验证普通聊天或向量请求，不等于验证流式回答、JSON 模式和所有模型参数；最终还需用一条问答及一份文档任务检查实际能力。协议参考 [Chat Completions](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)、[流式事件](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events) 与 [Embeddings](https://developers.openai.com/api/reference/resources/embeddings/methods/create)。

当前使用 Docker 运行后端。连接宿主机上的本地模型时，服务地址应使用容器可访问的地址（通常为 `http://host.docker.internal:端口/v1`），`localhost` 会指向后端容器本身。参见 [Docker Desktop 宿主机连接说明](https://docs.docker.com/desktop/features/networking/networking-how-tos/)。

网页保存的配置优先于 `.env` 默认值。只有修改数据库、存储目录等基础设施配置，或尚未保存网页配置时调整环境默认值，才需要 `docker compose up -d --force-recreate api worker`。当前界面暂未开放智能整理；高级选项的工具调用配置为后端流程保留，不影响普通知识问答。无认证的本地兼容服务也需要按服务说明填写占位密钥，才能启用连接。

旧文档可以在左侧「任务列表」统一查看错误并重试，补做未配置阶段。更换 Embedding 服务/模型/维度后，在设置里为当前库“重建向量索引”，或调用 `POST /api/settings/rebuild-embeddings`，请求体 `{"kb_id":"..."}`。旧 profile 与新 profile 隔离；查询只用当前指纹，不混用不同维度。默认精确 cosine 检索，适合小规模本地知识库。超长摘要可通过 `SUMMARY_INPUT_TOKENS` 和 `SUMMARY_MAX_CALLS` 限制单次上下文与总请求预算；预算耗尽明确报错并保留已生成的章节摘要。

## 使用

- 选择或新建知识库，创建多级文件夹；在文档列表筛选标签，通过「管理标签」新建、编辑或删除标签。拖入 PDF、DOCX、MD、TXT（默认单文件 50 MiB、批次 200 MiB/20 个）。相同内容会提示跳过或保留副本。
- 独立 worker 解析正文和来源锚点。无文本层 PDF 会明确报错，首版没有 OCR。
- 「文档管理」是完整知识库页面，左侧选择文件夹，右侧筛选、上传和批量管理文档；单击文档直接阅读。聊天右侧的资料管理仍支持单击详情、双击阅读。
- 使用多选、右键菜单和文件夹拖放进行管理；删除进入回收站。先恢复父文件夹，再恢复子文件夹和文档。
- 顶部搜索按钮或 `Ctrl/Cmd+K` 搜索；「历史」与输入区「问答范围」均在按钮旁展开悬浮卡片，点击外部或按 Escape 关闭。未发送草稿按知识库与会话分别保留；已有会话保留创建时的范围。
- 聊天点击「浏览资料」或引用时，按需展开右侧资料栏。多份资料使用可关闭标签，同一文档复用已有标签；只剩一份时收起标签栏，关闭全部恢复专注聊天。引用来自实际检索片段，可定位正文、PDF 页码或来源段落，支持原件下载。
- 「回收站」位于侧栏「设置」上方，是独立页面。先恢复父文件夹，再恢复子文件夹和文档；已删除知识库也可恢复。

新版布局与验收结果见 [工作区布局验收](docs/workspace-layout-validation.md)。

## 热更新开发

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

前端 Vite HMR、API `uvicorn --reload`、worker `watchfiles` 自动重启。开发与生产 URL 都为 http://localhost:3000。切回生产：`docker compose up --build -d --force-recreate`。

也可只在 Docker 启动数据库，其余在主机运行（PowerShell）：

```powershell
docker compose up db -d
$env:DATABASE_URL='postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster'
$env:UPLOAD_ROOT="$PWD/.data/uploads"
$env:RUNTIME_CONFIG_DIR="$PWD/.data/runtime"
cd backend
uv sync --frozen --python 3.12
uv run alembic upgrade head
uv run python -m app.db.seed
uv run python -m app.agent.graph --setup
uv run uvicorn app.main:app --host 127.0.0.1 --port 8000 --reload
# 另一个终端，使用相同 DATABASE_URL/UPLOAD_ROOT/RUNTIME_CONFIG_DIR 并进入 backend：
uv run python -m app.worker.main
# 第三个终端：
cd frontend
pnpm install --frozen-lockfile
pnpm dev
```

Windows/WSL2 请开启 Docker Desktop Linux engine。若有 3000/8000/55432 冲突，先停本项目旧预览或调整 Compose 端口。主机开发与 Docker 运行的上传目录不同，切换前应保留相应文件，不能把数据库指向不含原件的目录。

## 检查与测试

```powershell
cd backend
uv sync --frozen
uv run ruff check app tests
uv run pytest -q -p no:cacheprovider
cd ../frontend
pnpm typecheck
pnpm lint
pnpm build
pnpm test
# 完整站点运行后：
pnpm test:e2e
cd ..
backend/.venv/Scripts/python scripts/smoke.py
docker compose restart api worker db
backend/.venv/Scripts/python scripts/smoke.py --verify
```

离线 Pytest 使用真实解析器及确定性 fake provider（仅测试）；PostgreSQL 专项测试默认跳过，显式设置 `PG_INGESTION_TEST_URL`（入库）、`ZHICLUSTER_TEST_DATABASE_URL`（Agent）与 `PG_SETTINGS_TEST_URL`（配置）为专用测试库连接后运行。它们会创建、修改或清理验收数据，不要指向日常数据库；专库分别使用 `zhicluster_ingestion_test`、`zhicluster_agent_test`、`zhicluster_settings_test`。配置写入的浏览器专项默认跳过，只有在专用隔离站点设置 `E2E_BASE_URL` 与 `E2E_CONFIG_WRITES=1` 才启用，使用本地 HTTP 测试服务和合成密钥，不调用真实云模型。实际命令与结果见 [初版验收](docs/acceptance.md) 与 [界面和配置验收](docs/ui-redesign-validation.md)。

## 运维、持久化和备份

```powershell
docker compose logs -f api worker
docker compose stop
docker compose start
docker compose down
```

`down` 保留数据库、上传和运行密钥卷；**`docker compose down -v` 会删除全部本项目数据**。PostgreSQL 在 `zhicluster_postgres` 卷，原件在 `zhicluster_uploads` 卷的 `/data/uploads/<kb>/<document>/original`，不作为 web 静态资源发布。网页配置的加密主密钥在私有 `zhicluster_runtime` 卷 `/app/runtime/master.key`，API 与 worker 必须挂载同一份；主机开发使用相同的 `RUNTIME_CONFIG_DIR`。主密钥丢失或不匹配时相关请求会明确报错，worker 暂停领取任务，需要恢复原密钥。

数据库备份可用 `docker compose exec -T db pg_dump -U zhicluster -d zhicluster -Fc -f /tmp/zhicluster.dump`，再用 `docker compose cp db:/tmp/zhicluster.dump ./zhicluster.dump` 导出（避免旧版 PowerShell 重定向破坏二进制）。上传卷可用 `docker run --rm -v zhicluster_uploads:/source:ro -v "${PWD}:/backup" alpine tar -czf /backup/zhicluster-uploads.tar.gz -C /source .` 备份；运行密钥卷同理将源改为 `zhicluster_runtime` 并输出独立私有归档。密钥备份应按凭证保管，不提交仓库。恢复前停 API/worker，使用 `pg_restore` 到明确的目标库，同时恢复对应上传卷和原运行密钥卷。应同时保留 DB 快照、原件和解密密钥。迁移执行 `docker compose run --rm migrate`，含幂等 seed 和 checkpoint setup。

常见问题：任务排队不动检查 worker 日志；扫描 PDF 无文字层不能解析；模型 401/429/超时在设置与任务错误中可见；变更模型后重建向量；代理 SSE 要禁用缓存（仓库 Nginx 已配置）；取消订阅或关闭网页不会取消后台任务。

更多实现边界：[架构](docs/architecture.md)、[数据模型](docs/data-model.md)、[API](docs/api.md)、[最终实现报告](docs/implementation-report.md)。
