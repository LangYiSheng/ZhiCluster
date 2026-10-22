# 界面与网页配置改造验收

日期：2026-10-22。对应本次工作区改造；初版 M0–M5 验收仍见 [acceptance.md](acceptance.md)。

用户故事：在统一的知识工作台打开设置，编辑、测试并保存模型与处理参数；后端持久化配置，新请求和独立 worker 自动采用，返回后继续原对话并打开真实来源。

## 完成矩阵

| 范围 | 状态 | 实际行为 |
| --- | --- | --- |
| 字体 | 完成 | 本地 Noto Sans SC / Noto Serif SC，界面 14px、辅助 12px、阅读 16px；宋黑/黑体可选，保留 OFL |
| 配色 | 完成 | 暖白墨黑、鼠尾草绿，浅色/深色/跟随系统，语义颜色统一 |
| 工作区布局 | 完成 | 单主侧栏、按需资料栏；可拖动/键盘调整；1100px 折叠实际释放宽度；手机使用抽屉 |
| 设置布局 | 完成 | 外观、模型、处理、索引四组；独立工作区、平铺字段、高级选项折叠、固定保存操作 |
| 配置保存 | 完成 | GET/PUT、revision 乐观锁；加载/保存/校验/冲突/失败提示；不自动覆盖未保存草稿 |
| 密钥 | 完成 | 后端 Fernet 加密；留空保留、新值替换、明确清除；不回传、不进浏览器存储 |
| 连接测试 | 完成 | 使用未保存草稿；聊天/向量/工具调用各自执行；结果区分测试与保存，并标记已过期结果 |
| 配置生效 | 完成 | API 新请求、worker 新领取任务读取数据库；同一执行尝试使用固定快照；重试取新快照 |
| 索引维护 | 完成 | 明确选择目标库、费用确认、只使用已保存配置；未保存修改时不能重建 |
| 对话连续性 | 完成 | Chat 跨设置保持挂载，SSE 继续；草稿按知识库/会话隔离恢复；提交失败保留输入 |
| 原功能 | 完成回归 | CRUD、上传解析、PDF/DOCX/MD/TXT 阅读定位、搜索、拖放、批量管理、回收恢复、Agent 整批审批 |
| 云模型质量 | 外部条件受阻 | 未使用真实 API Key，不把受控 HTTP 服务测试当作真实云模型效果证明 |

参考 ChefMate 当前仓库的字体角色、语义配色、侧栏与设置分组；本次没有修改 ChefMate。知簇继续使用原 React/FastAPI/PostgreSQL 架构和既有业务接口。

## 实际验证

| 层级 | 结果 | 证据 |
| --- | --- | --- |
| 后端完整测试 | **104 passed** | SQLite、真实解析器、确定性 provider 单元测试，加三组真实 PostgreSQL 专项；无跳过 |
| 后端静态检查 | 通过 | `ruff check app tests alembic/versions/04_runtime_configuration.py` |
| 前端行为测试 | **21 passed** | 设置 11、聊天 3、Agent 2、API 4、SSE 1 |
| 类型与 lint | 通过 | `pnpm typecheck`、`pnpm lint` |
| 生产构建 | 通过 | 主机 Vite 与 Docker 镜像构建；包含本地字体，不请求第三方字体 CDN |
| 隔离配置浏览器链路 | **1 passed** | 实际浏览器 → API8002 → 独立 PG 库 → 独立 worker → 本地 HTTP provider → pgvector → 引用阅读器 |
| 生产站点浏览器回归 | **4 passed，1 按设计跳过** | Docker3000 上的原功能三场景与全尺寸布局一场景全部通过；配置写入专项在日常站点跳过，已在隔离站点单独通过 |

隔离配置场景使用专库 `zhicluster_ui_redesign_test`、站点 3002、API8002，与日常上传和配置隔离。HTTP 测试服务只在 E2E 进程中启动，凭证是明确合成字符串，测试结束恢复默认配置并关闭服务。没有拦截网页业务 API，也没有在产品运行路径加入模拟响应。

验证内容包括：草稿测试不改变 revision；单 scope 不额外调用其它服务；保存后刷新/另一页面能读取；密码框为空且标记已配置；空值保留的密钥确实用于下一次 HTTP 请求；清除后不再配置；并发写冲突保留草稿；worker 不重启就使用新向量模型、3 维向量和单片段批次；实际上传长文产生多片段与多次 HTTP 请求。随后开启受控流式回答，生成中切到设置，后台完成后返回看到全文与引用，点击引用打开原文行号。

响应式覆盖：1440×900、1100×800、900×780、390×844、844×390、320×640；检查无水平溢出、输入框在可视范围内、侧栏折叠释放超过 200px、字体实际加载。设置还覆盖桌面、手机与横屏。

本次发现并修复一个原有偶发问题：Windows 同一时钟刻度产生的提问和回答曾以随机 UUID 决定顺序。现在会话行锁内分配严格递增的消息时间，并有冻结时钟、递减 UUID、连续两轮 API + worker 的回归。

生产数据回归另发现大量已删除知识库会将文件列表挤到底栏后，导致文档恢复菜单无法点击。已删除知识库现在默认折叠，展开后使用最多 160px 的独立滚动列表；浏览器回归会验证折叠、展开高度和文档恢复。Linux 生产容器另实测临时主密钥初始化、加解密和 `0600` 权限，确认 API/worker 挂载同一 runtime 卷。

## 复现命令

```powershell
cd backend
$env:PG_INGESTION_TEST_URL='postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster_ingestion_test'
$env:ZHICLUSTER_TEST_DATABASE_URL='postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster_agent_test'
$env:PG_SETTINGS_TEST_URL='postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster_settings_test'
uv run pytest -q -p no:cacheprovider --basetemp ../.test-tmp-ui-acceptance
uv run ruff check app tests alembic/versions/04_runtime_configuration.py
cd ../frontend
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

三组 PostgreSQL 变量必须指向上述已创建的专用库。Agent 与配置专项先迁移专库；入库专项按自身 fixture 建表。默认 `pnpm test:e2e` 不启用配置写入专项。

配置专项需另启隔离服务：数据库名 `zhicluster_ui_redesign_test`，API 与 worker 使用相同 `DATABASE_URL`、独立 `UPLOAD_ROOT` 和 `RUNTIME_CONFIG_DIR`，模型密钥环境变量为空；执行 Alembic、seed 和 checkpoint setup。API8002 的 `CORS_ORIGINS` 设置为 `["http://127.0.0.1:3002"]`，Vite3002 的 `VITE_API_PROXY=http://127.0.0.1:8002`。启动 API 与 worker 后：

```powershell
$env:E2E_BASE_URL='http://127.0.0.1:3002'
$env:E2E_CONFIG_WRITES='1'
pnpm test:e2e
```

## 启动与边界

`docker compose up --build -d`，打开 <http://localhost:3000>，设置页填写模型信息并保存。生产数据保留在既有 PostgreSQL/上传卷，迁移04只添加运行配置表；另加共享私有 `zhicluster_runtime` 卷。API 文档 <http://localhost:8000/docs>。完整开发、备份与恢复步骤见 [README](../README.md)。

当前没有配置历史回滚或网页修改基础设施配置。主密钥和数据库必须配套备份，丢失密钥会明确失败，不能以环境配置掩盖；`/ready` 仅检查数据库与本地用户。字体文件合计约 21.4MB，按实际使用角色加载，首次打开会有本地传输成本。Vite 保留既有主入口体积提示，不影响构建成功。设置离开保护的 Vitest 有一条 React19 异步 `act` 调度诊断，功能断言与真实浏览器均通过，未消音；这不是零警告验收。

最终 Docker API 与数据库健康、worker 正常运行，站点保留在 <http://localhost:3000>。测试专用 API8002/Vite3002/worker 已停止；专用测试库和被忽略的 `.data/ui-preview` 保留供复查，未提交运行密钥、上传原件或测试 provider 凭证。生产模型配置未被验收脚本改写，未使用 ChefMate 的模型配置或密钥。

## 生产界面截图

![统一后的知识工作台](images/ui-workbench-light.png)

![外观设置](images/ui-appearance.png)

![模型连接设置](images/ui-settings-models.png)

![手机工作台](images/ui-workbench-mobile.png)
