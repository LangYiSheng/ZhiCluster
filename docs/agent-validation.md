# Agent 实现与验证记录

验证日期：2026-10-22。所有测试规划模型均明确为确定性的 fake model，未使用真实云端密钥，不代表真实模型联网验收通过。

## 实现边界

- `langchain.create_agent` 只得到 7 个只读工具；`ToolStrategy(PlanDraft)` 对模型计划做 Pydantic 判别联合校验，不能调用 Shell、SQL、Python 或业务写工具。
- LangGraph 实际执行 Plan → Review（`interrupt`）→ Execute → Verify；审批通过 `Command(resume=...)` 恢复。生产使用官方 `PostgresSaver`，通过 `setup()` 初始化到独立 `agent_checkpoints` schema。
- 上传/聊天共用的数据库任务队列通过 `kind=agent` 调用独立 worker；HTTP 创建任务不等待模型调用。
- 业务计划、逐项操作、审批版本、事件、审计和撤销记录单独存入业务表。工作流 checkpoint 仅持有运行/计划 ID 与审批状态，不替代审计和撤销。
- 批准执行数据库中用户编辑后的最终计划；检查本库权限、资源存在性、版本、依赖和高风险软删除确认。所有元数据变更在一笔数据库事务内完成。
- 行锁、锁后 identity map 刷新、终态检查和 PostgreSQL session advisory lock 防止重复执行及并发修改同一工作流线程。执行失败后可用新审阅版本重试。
- 创建目录、移动、标签、重命名、软删除均可撤销；撤销检查执行后的版本及后续关联，遇到人工修改拒绝覆盖。
- SSE 持久事件带 sequence、timestamp 和可读活动描述；支持 `after` 与 `Last-Event-ID` 游标恢复；任务 GET 可在重启后恢复完整待审批计划。
- Agent 作业取消立即同步 `run.cancelled`；规划前、每次工具事件与计划落库前都检查作业状态和租约 owner。待审批计划与 `job.completed` 在同一业务事务提交，消除取消窗口。旧 worker 失租后只退出，不保存过期计划、事件或错误，不覆盖新 worker 的状态。

## 实际命令

PowerShell，从 `backend` 目录执行。测试数据库为本地容器中的独立 `zhicluster_agent_test`，没有清空或修改主数据库的数据。

```powershell
$env:DATABASE_URL='sqlite://'
$env:ZHICLUSTER_TEST_DATABASE_URL='postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster_agent_test'
New-Item -ItemType Directory -Force -Path '..\.test-tmp' | Out-Null
.venv\Scripts\python.exe -m pytest tests/test_agent_workflow.py tests/test_agent_postgres.py tests/test_agent_api.py -q -p no:cacheprovider --basetemp ..\.test-tmp\agent-final
.venv\Scripts\python.exe -m ruff check app/agent app/api/agent.py tests/test_agent_workflow.py tests/test_agent_postgres.py tests/test_agent_api.py
```

当前 PostgreSQL 测试模块会先严格检查 URL 的数据库名称为 `zhicluster_agent_test`，再以独立子进程执行 `alembic upgrade head`。目标专库必须已存在；其他数据库名会被拒绝，避免把测试迁移施加到应用主库。官方 checkpoint 的幂等初始化由模块内测试覆盖。未启用 PostgreSQL 时普通 API/工作流测试仍使用 SQLite。

历史数据库核验：首次迁移版本 `14703c2af5e7`，当时 public schema 有 24 张业务表及 `alembic_version`，checkpoint schema 有 4 张官方 saver 表。本次运行配置迁移 `04_runtime_configuration` 后为 25 张业务表；新增迁移无需再依赖人工预先升级旧测试库。

本次自动迁移补充验收：在仍停留于旧迁移的 Agent 专库上运行 `tests/test_agent_postgres.py`，模块先升级到 head，再完成 **`9 passed in 13.34s`**；相关 Ruff 检查通过。该结果覆盖真实 PostgreSQL 工作流和事务，不涉及真实云端模型。

首轮 Agent 定向测试输出：`18 passed in 11.02s`。追加并发目录和取消/租约保护后，最终 Agent 定向测试输出为 **`24 passed in 13.83s`**，Ruff：`All checks passed!`。早期一次 HTTP 测试因缺失 `.test-tmp` 父目录出现 2 个环境 setup error；创建父目录后重跑全部通过。

## 验证覆盖

| 内容 | 类型 | 结果 |
| --- | --- | --- |
| 计划类型、未知参数、循环/缺失依赖、重复操作 ID、临时目录引用 | 确定性单元测试 | PASS |
| 真正的 create_agent 调用只读工具并返回经过验证的计划 | fake BaseChatModel + SQLite 业务表 | PASS |
| 未查阅资料的模型计划不能提交 | fake BaseChatModel | PASS |
| 用户修改目标后执行最终版本，重复批准只有一次业务执行 | SQLite + PostgreSQL | PASS |
| 高风险软删除必须额外确认、可恢复、保留 storage_key | SQLite 业务事务 | PASS |
| 拒绝审批不修改目录/文件/标签；不存在撤销快照或业务审计 | SQLite 业务事务 | PASS |
| 文档/目录/标签跨知识库引用拒绝 | SQLite 业务事务 | PASS |
| 审批版本冲突、编辑版本冲突、后续人工修改阻止危险撤销 | SQLite + PostgreSQL | PASS |
| 新建目录→移动→标签，标签 Unicode 归一化，撤销全部副作用 | SQLite 业务事务 | PASS |
| 目录/标签修改保持文档索引状态，不触发重新向量化 | SQLite 业务事务 | PASS |
| 官方 PostgresSaver.setup 连续两次执行，专用 schema 内 4 张表 | 真实 PostgreSQL | PASS |
| 待审批状态关闭连接后，由独立 Python 进程恢复并执行用户编辑版本 | 真实 PostgreSQL + 独立进程 | PASS |
| 两个线程同时批准同一计划，仅 1 次重命名审计、1 条撤销记录、文件 version=2 | 真实 PostgreSQL + 双连接并发 | PASS |
| 规划中取消后 run/job 均 cancelled，不保存待审批计划，禁止审批且无业务变更 | 真实 PostgreSQL + 可控 fake planner + 实际取消服务 | PASS |
| 旧 worker 失租后返回计划、发事件、模型失败三条路径均被 fence，新 worker 可继续规划 | 真实 PostgreSQL + 可控 fake planner | PASS |
| 并发互相移动两个目录只能成功一次，另一次拒绝形成循环 | 真实 PostgreSQL + 双连接并发 | PASS |
| Agent HTTP GET/PATCH、无 Key 明确拒绝、SSE sequence/timestamp、Last-Event-ID 重放 | FastAPI TestClient | PASS |
| Agent Ruff | 实际静态检查 | PASS |
| 真实云端模型工具能力、真实自然语言整理质量 | 缺少真实 API Key | BLOCKED |

SQLite 仅用于明确标记的离线测试。生产 Agent 在非 PostgreSQL 数据库上会明确报错，不会静默回退到内存 checkpoint。PostgreSQL 测试在未设置 `ZHICLUSTER_TEST_DATABASE_URL` 时标记 SKIPPED，不冒充 PASS。

## 当前限制

- 整理的写操作限于当前知识库；跨知识库移动没有开放。
- 只读工具分页查文档，上限为每页 100；目录及标签读取当前最多 1000 条，适用于首版本地 Demo。
- 本轮验证了工作流、权限和事务正确性，真实云端模型对复杂自然语言的规划质量仍需配置模型后验收。

## 核对过的官方文档

- [LangChain 结构化输出与 ToolStrategy](https://docs.langchain.com/oss/python/langchain/structured-output)
- [LangGraph interrupt 与 Command 恢复](https://docs.langchain.com/oss/python/langgraph/interrupts)
- [LangGraph 持久化与 PostgreSQL saver](https://docs.langchain.com/oss/python/langgraph/persistence)
- [PostgreSQL 短期记忆初始化示例](https://docs.langchain.com/oss/python/langgraph/add-memory)

通过项目指定的 Context7 CLI 查询，并对安装后的 `PostgresSaver.from_conn_string`、`ChatOpenAI` 签名及真实导入做了检查。
