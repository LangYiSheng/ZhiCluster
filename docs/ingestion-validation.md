# 入库与检索专项验收

验收日期：2026-10-22。以下结果来自实际运行；确定性 fake provider 仅用于测试，不进入正常业务路径。

## 自动化结果

| 项目 | 状态 | 实际证据 |
| --- | --- | --- |
| 四格式真实解析、Markdown 标题层级、中文编码、DOCX 表格顺序、PDF 页码与目录、无文本层错误 | PASS | `test_ingestion_parsers.py` 6 项 |
| Chat/Embedding 独立地址与密钥、有限重试、维度与数值校验、SSE 协议、无 Key 拒绝伪输出 | PASS | `test_ai_gateway.py` 中 HTTPX MockTransport 协议测试 |
| 层级摘要单次输入限制与调用预算、分类别名复用及跨库 ID 拒绝 | PASS | `test_ai_gateway.py` 中 fake gateway 测试 |
| 数据库任务领取、心跳、过期租约恢复、耗尽上限、软删除取消、无 Key 降级 | PASS | `test_ingestion_worker.py`，SQLite 单元集成环境 |
| 向量批次已完成结果复用、重命名不重解析、仅重建向量、AI 建议仅持久化不应用 | PASS | `test_ingestion_worker.py`，fake provider 测试 |
| PostgreSQL `FOR UPDATE SKIP LOCKED` 双会话排他领取及租约恢复 | PASS | `test_ingestion_postgres.py::test_pg_skip_locked_exclusive_claim_and_lease_recovery` |
| 模型返回前租约移交，旧 worker 不再保存向量 | PASS | `test_pg_old_worker_cannot_save_vectors_after_lease_transfer`，真实 PostgreSQL 双会话 |
| PostgreSQL 上 PDF / DOCX / MD / TXT 完整解析→分块→中文关键词检索 | PASS | 参数化 4 项，真实生成文件及 `pg_trgm`/ILIKE 查询 |
| PostgreSQL 上空白 PDF 失败且明确不支持 OCR | PASS | `test_pg_empty_pdf_explicitly_fails` |
| 3→4 维切换保留独立 profile，真实 pgvector 精确 cosine、SQL 中 KB/profile 过滤及越权拒绝 | PASS | `test_pg_profile_switch_exact_cosine_and_scope_filter`；向量由可控 fake provider 生成 |
| 真实云端摘要 / 分类 / Embedding 质量和兼容服务联网 | BLOCKED | 未提供真实模型凭据，未冒充联网验收 |

补充空流错误、流中断不重试、租约移交保护后，最新专项合并输出为 `33 passed in 12.14s`（25 项本地解析/协议/SQLite 测试，8 项真实 PostgreSQL 测试），对应 Ruff 检查 `All checks passed!`。后续全项目结果以 [acceptance.md](acceptance.md) 为准。

## 运行命令

在项目根目录进入后端：

```powershell
cd backend
.\.venv\Scripts\python.exe -m pytest tests/test_ingestion_parsers.py tests/test_ai_gateway.py tests/test_ingestion_worker.py -q -p no:cacheprovider --basetemp D:\Dev\ZhiCluster\.test-tmp-ingestion
.\.venv\Scripts\python.exe -m ruff check app/ai app/ingestion app/worker tests/test_ingestion*.py tests/test_ai_gateway.py
```

PostgreSQL 专项仅允许使用名为 `zhicluster_ingestion_test` 的独立数据库，拒绝对应用数据库运行迁移。先创建该数据库，再执行：

```powershell
$env:PG_INGESTION_TEST_URL = 'postgresql+psycopg://zhicluster:local_password@127.0.0.1:55432/zhicluster_ingestion_test'
.\.venv\Scripts\python.exe -m pytest tests/test_ingestion_postgres.py -v -p no:cacheprovider --basetemp D:\Dev\ZhiCluster\.test-tmp-ingestion-pg
.\.venv\Scripts\python.exe -m pytest tests/test_ingestion_parsers.py tests/test_ai_gateway.py tests/test_ingestion_worker.py tests/test_ingestion_postgres.py -q -p no:cacheprovider --basetemp D:\Dev\ZhiCluster\.test-tmp-ingestion-combined
```

测试 fixture 在独立库实际执行 `alembic upgrade head`，保留入库记录供检查。未配置上述环境变量时明确显示 SKIPPED。

## 实测发现与修复

首次 PostgreSQL 新库迁移发现复合外键引用 `document_chunks(id,kb_id)` 时，对应唯一约束尚未建立。已修正迁移顺序为先创建所有复合唯一约束，再创建外键；随后完整 7 项 PostgreSQL 测试通过。

入库 worker 在每次模型请求返回、保存向量/摘要/建议前重新核验任务租约归属和文档软删除状态。租约已经移交时，旧 worker 放弃结果；批次成功后单独提交，重试只处理当前 profile 下缺失向量。

## 边界

解析与分块是确定性本地工作。未配置 AI 时任务结束为 `partial_ready`，文档解析状态为 `ready`，AI 子阶段为 `unconfigured`，阅读与关键词检索可用。摘要和分类失败保留已有结果，用户可补配置后重试；调用预算耗尽会明确失败，不会无限调用。

数据库领取和写入幂等可以避免本地重复保存；若提供方已经完成请求、worker 在提交向量前崩溃，网络调用可能重发。通用 OpenAI 兼容接口没有可依赖的统一计费幂等保证，因此不能承诺此窗口绝不重复计费。
