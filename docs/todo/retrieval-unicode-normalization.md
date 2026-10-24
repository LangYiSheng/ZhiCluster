# 检索 Unicode 归一化一致性计划

日期：2026-10-24。状态：已完成只读调查，等待安全窗口与实施协调；本文不代表已修改映射、迁移或运行数据库。

## 问题与边界

`terms.normalized()` 使用 `NFKC + casefold`，查询规划和本地 lexical 评分都调用它，但 `search.py` 的 SQL 正文/标题准入及 relevance 使用原始 `content` / `display_name`。例如正文和查询都为 `ＡＢＣ１２３` 时，查询被变成 `abc123`，SQL 却无法命中原文，本地评分还没有机会执行。半角片假名、兼容连字、罗马数字、圈号、单位兼容字符及 `Straße/strasse` 同样可复现。

独立诊断文件 `backend/tests/test_retrieval_unicode_admission.py` 已验证：SQLite 真实上传→worker→搜索有 13 条正文及 3 条标题缺陷复现；6 条反向查询/ASCII 字面 LIKE 控制通过。专用 PG 中 13 条正文复现失败。用户结束持续优化后，缺陷用例作为 `xfail(strict=True)` 明确保留，使用 `--runxfail` 可重现红测；控制仍为普通测试。这些不是已完成修复，也不能把 xfail 数计为通过。

本轮约束：两个影子字段均为 `Text`；原文、原文件名、展示名、section、chunk offset/anchor 不变；用户输入经归一化后仍必须经过 `escape_like()`，`%`、`_`、反斜杠继续作为字面值。候选预算、分页、权限与范围门禁、向量、rerank、索引策略不在本次语义修复范围。

**目前旧 ORM 映射的查询规划与 DRCD 长评估进程仍在运行。实施前不得迁移当前评估 DB 或日常 DB，也不得重建/重启其服务。** 后续先在内存 SQLite 和明确专用的测试库验证，运行库迁移由根任务在安全窗口单独协调。

## 字段与统一派生规则

计划增加 `documents.search_display_name: Text NOT NULL` 和 `document_chunks.search_content: Text NOT NULL`。使用 Text 是因为 NFKC/casefold 可以展开字符串，展示名原来的 255 字符约束不能直接套用到派生值。

把现有语义提取为不依赖 ORM、配置或查询规划的稳定版本函数，例如 `normalize_search_text_v1(text)`；`terms.normalized` 委托给它，数据库写入和 Alembic Python 回填也调用这个同一函数。版本 1 的行为固定为 `unicodedata.normalize('NFKC', text).casefold()`，未来 Unicode 策略变更另起版本和回填，不能悄悄修改旧迁移的含义。记录测试/运行 Python 与 `unicodedata.unidata_version`，避免不同 Unicode 数据版本混写后被误认为完全一致。

不使用 DB `lower()` 替代 Python casefold，不在 SQL 中枚举全角变体，也不覆盖原字段。迁移不导入当前 ORM 映射或应用配置来访问数据；只导入稳定的纯函数，并使用 revision 内显式声明的轻量 Table。

## 写入审查清单

以下审查覆盖当前仓库 `backend/app`、`backend/tests`、`scripts` 的 Python 代码，结合构造调用 AST 清单、字段赋值及 SQL/bulk 搜索。行号用于当前版本定位，后续修改后以符号为准。

| 路径 | 当前实际写法 | 要求 |
| --- | --- | --- |
| `backend/app/api/library.py:308` | 上传创建 Document，`db.add/flush`；重复文件直接返回已有记录 | ORM 创建自动派生搜索名；保留副本走同一机制；重复分支依赖已回填数据 |
| `backend/app/services/library.py:141` | `update_document` 中赋值 `display_name`，含人工重命名 | 同一 flush 写入展示名与搜索名，不增加额外 SELECT、版本号或审计次数 |
| `backend/app/agent/executor.py:333,338` | Agent rename 经 `library.update_document` | 不另写一套派生逻辑；验证 Agent 执行路径 |
| `backend/app/agent/executor.py:433,435` | Agent undo 把旧 display_name 传回 `update_document` | 撤销重命名也要同步；旧审计/撤销记录无影子字段仍可使用 |
| `backend/app/worker/pipeline.py:104` | 正常解析后 ORM 逐个创建 DocumentChunk | 首次切片、解析重试、删除旧 chunk 后重建均自动派生正文 |
| `backend/app/worker/pipeline.py:122` | durable parse 后无 chunk 时恢复创建 | 单独验收这条恢复分支，不能仅验证首次解析 |
| `backend/app/services/library.py:223`、folder delete、trash restore | 批量移动/标签/软删除/恢复更新元数据；当前不批量重命名 | 不因普通状态更新清空影子值；保留现有 no-op version、事务与审计语义 |
| `backend/app/api/workflows.py`、worker enrichment/pipeline | 更新 parse/index/summary/classification/error 等状态，不修改展示名或正文 | 不重新读取原文，不产生多余 UPDATE；与并发重命名回归一起检查 |
| `backend/app/services/trash.py`、worker parse retry | Core delete 文档/chunk 或重建 chunk | 删除与 FK 语义不变；新建 chunk 重新派生，不需要清理独立搜索表 |
| `scripts/retrieval_benchmark.py:123,125` | `Session.execute(insert(Document/DocumentChunk), list[dict])` | **真实 bulk 绕过点**，不能只依赖 mapper 事件；保持批量执行和原数据口径 |
| `backend/tests/retrieval_fixtures.py:53,55` | 相同的 Session bulk insert，多片段分页/PG/performance fixture 共用 | 自动派生逐行正确，增加含 Unicode 的 bulk 控制，不把 fixture 手填影子值当作覆盖 |
| `scripts/library_benchmark.py:39,129` | ORM `add_all` 构建规模/批量场景 | 随 ORM 自动同步；新规则不能把 N 条 INSERT 变成 N 次额外读 |
| `scripts/benchmark_cmrc.py`、`scripts/smoke.py` | 调用上传 API；smoke 的 `docx.Document` 是 Word 文档对象 | 前者已汇入上传/worker路径；后者不能误算成 ORM Document 构造 |

直接 ORM 测试构造位置也应保持可用，而不是要求每个测试手填新字段：`test_agent_api`、`test_agent_metadata_deletion`、`test_agent_postgres`、`test_agent_workflow`、`test_chat_tools`、`test_ingestion_postgres`、`test_ingestion_worker`、`test_jobs_pagination`、`test_library_batch`、`test_library_scale`、`test_library_scale_postgres`、`test_metadata_deletion_postgres`、`test_metadata_disappearing_postgres`、`test_retrieval_quality`、`test_retrieval_unicode_admission`、`test_review_api`、`test_trash`、`test_worker_scheduler`。测试中直接 ORM 重命名包括 ingestion 并发和 security freshness 场景，必须自然同步。

当前受审代码没有 Document/DocumentChunk 的 Core UPDATE、`bulk_update_mappings`、`bulk_insert_mappings`、`bulk_save_objects`、INSERT FROM SELECT、UPSERT、COPY 或直接 SQL 文本写入。它们仍需在新机制的覆盖/拒绝矩阵中出现，不能因为当前没有调用就默认它们安全。忽略目录 `.data` 中历史源码快照、一次性探针和运行中的旧进程不属于新写入接口；迁移时必须停止旧 writer，不能依赖旧进程自动装载新策略。

## 同步机制选择

选择一个集中定义的“源字段→影子字段→v1 函数”策略，由持久化层适配不同 SQLAlchemy 写法；入口代码不得各自拼凑归一化。该策略包含三个明确职责：

1. **INSERT 自动派生**：影子列使用上下文 Python default，按当前行的源字段计算；覆盖 ORM add/add_all、Session bulk INSERT、Core Connection INSERT、executemany 和多行 VALUES。普通 ORM INSERT 同时可在 mapper 同步器中赋值，以保证 flush 后对象可读。default 不覆盖显式值，因此还需要后面的校验，不能把 default 本身当作完整保证。
2. **ORM UPDATE 同步**：集中 mapper `before_insert/before_update` 适配器调用相同策略。只在源字段创建/改变时更新影子，不用无条件 `onupdate`：状态/版本更新的参数中通常没有源文本，无条件 context onupdate 可能把影子置空或要求额外 SELECT。同步只改本行字段，不查询目录、标签或数据库。
3. **bulk/Core 写入门禁与统一 helper**：为源文本的 bulk UPDATE 提供同一个派生 values/helper，源值和派生值必须在同一条 DML/同一事务内写入；不逐行回读。应用 Engine 执行边界校验实际写入的配对值，缺失或不一致时在执行前抛错并回滚，防止直接 bulk 路径静默留下陈旧值。不能可靠推导的 SQL 表达式更新、INSERT FROM SELECT、UPSERT 更新分支及原始 SQL 写源字段先明确拒绝。普通不涉及两列的状态更新和删除仍允许。

门禁覆盖不能只安装在一个 Session：生产 `make_engine`、测试 `conftest` 和两个 benchmark 中直接 `create_engine` 的位置需要统一安装。Alembic 使用独立、显式的迁移连接，不用当前 ORM mapper 同步数据。最终执行前校验可以利用 SQLAlchemy 连接事件和编译执行上下文；**阶段 1 必须先证明各条批量路径均可识别和正确校验，不能靠不完整的 SQL 字符串匹配宣布全覆盖**。必要时收窄受支持的 DML 形态，并通过受控 helper 提供清晰替代，而非放行无法证明正确的操作。

驱动直连、外部数据库管理客户端不在 Python Engine 事件覆盖之内。Python default 不会成为数据库 server default；NOT NULL 只能拦住缺失影子的直接 INSERT，不能保证直接 SQL UPDATE 的一致性。因此不声称数据库已对任意外部 writer 强制此不变量。维护写入必须使用受控 helper/专门回填流程；当前应用不提供任意 SQL 写入功能。将来若需要外部 writer，必须先设计与同一 Unicode 版本严格一致的 DB 能力，再开放该能力。

采用该组合的依据：[SQLAlchemy defaults](https://docs.sqlalchemy.org/en/20/core/defaults.html) 明确支持逐行上下文默认值；[ORM events](https://docs.sqlalchemy.org/en/20/orm/events.html) 明确 mapper 事件只覆盖 flush，不覆盖 ORM bulk DML；[Core events](https://docs.sqlalchemy.org/en/20/core/events.html) 提供连接执行边界。不能只安装 mapper 事件，也不能仅给四个当前入口加字段。

## 分阶段实施与验收门槛

### 阶段 0：计划与冻结（本次）

- 保存本文、诊断红测、写入清单与当前数据库统计口径。
- 不改产品映射、不创建迁移、不运行迁移、不重建服务；旧映射长评估继续运行。

### 阶段 1：先证明持久化机制

在内存 SQLite 和专用 `zhicluster_ingestion_test` 验证写入矩阵。独立用例应至少包含：ORM 单条/批量构造、ORM 重命名、仅状态更新、Session bulk INSERT、Core INSERT、executemany、多行 VALUES、正确的 bulk UPDATE、缺失/错误影子更新、显式错误影子 INSERT、legacy bulk API、表达式 UPDATE、UPSERT/INSERT FROM SELECT、原始 SQL 写入。

支持的形态必须派生正确；不支持的形态必须在写入前明确失败，事务不能留下部分行。覆盖 `％/＿/＼` 的归一化与字面 LIKE 控制，保留 ASCII 对照。增加多个不同 Unicode 行的 executemany，避免 default 错用首行值。对 Session 缓存与重读检查值一致。若门禁未能可靠覆盖某形态，先完成机制调整，不切搜索 SQL。

### 阶段 2：字段、回填与源码路径

- 新增两个 Text 字段、统一策略与所有 engine 安装，保持 mapper/fixture/bulk 的语义一致。
- Alembic revision 先增加 nullable 字段，再 Python 分批回填，校验无缺失/无不一致，最后设 NOT NULL；不设置掩盖遗漏的空字符串 server default。
- 回填用显式 Table 仅更新目标影子字段，不经过 ORM `Entity.updated_at` 默认值；文档 version、updated_at、审计、任务、索引状态均不得因回填变化。
- 按主键 keyset 分批，例如文档 1000 行、chunk 500 行；同一个迁移事务，不逐行提交，不把全部正文载入内存。包含软删除记录，确保恢复后也可搜索。
- 迁移记录迁移版本/行数/Unicode 版本。PG 利用事务失败回滚；SQLite 的 batch-alter/rebuild、外键和失败行为必须实际测，不能把 PG 的事务 DDL 结论直接套给 SQLite。离线 `--sql` 无法执行 Python 回填时明确说明需在线连接，不生成看似完整但缺数据的脚本。
- SQL 准入与 SQL relevance 一起切换到影子列，仍在 query normalized 后 escape，保持限定字段/范围与 candidate budget 不变。
- 通用 `library.snapshot()` 当前遍历所有 table columns；影子列必须标记为内部派生字段并在该公共快照路径排除，避免文档 API、审计和 Agent undo/冲突快照扩散内部字段。针对返回 JSON 的键集合补回归。

### 阶段 3：行为、迁移与性能验收

- 原诊断 16 条 SQLite / 13 条 PG 由红转绿，补 PG 反向查询和 ASCII 字面 LIKE 控制、全角标题重命名后旧/新名查询、Agent 执行/撤销、worker 两个 chunk 创建分支。
- SQLite/PG 各创建旧 revision 数据再 upgrade：混合 Unicode、软删除记录、空库、已有 chunk、长字符串展开。核对原始文本、offset、anchor、ID、version、时间戳、审计数量和 FK 均不变，影子值逐行等于 v1 函数；再 downgrade/upgrade 检查可重建性。
- 写入失败、bulk 中间坏行、重命名回滚、并发 rename/worker 状态更新后检查配对字段，确保不能出现源名已变但影子仍旧。
- 运行现有检索范围/分页/LIKE、入库恢复、元数据与 Agent 回归，Ruff。记录 bulk fixture 装载时间和 SQL 数量，不接受每行附加 SELECT；记录候选查询延迟和字段载荷，不宣称归一化自动解决索引性能。
- 运行公开数据集逐题对照：先小样本，再完整已固定语料；记录前 10 文档与前 5 答案证据变化、倒退样本和延迟。已有结果属于旧实现基线，必须另标新 revision，不能混记运行。

### 阶段 4：安全窗口发布

根任务确认所有旧 ORM 长评估和 writer 已结束后，先备份目标库并停止 API/worker 写入，迁移并校验，再以同一新代码启动 API/worker；检查真实上传、重命名、恢复与检索。**不允许新旧 writer 混跑**：旧进程 INSERT 会缺新列，旧 rename UPDATE 则可能留下陈旧影子。数据库迁移与日常服务更新分别得到协调后执行，不能让测试 fixture 自动迁移当前评估或日常库。

## 回填失败与回滚

- 在未迁移的本阶段，回滚仅删除/修订计划和诊断文件；运行库没有变化。
- PG upgrade 失败时让整笔迁移事务回滚，确认 Alembic revision 与两列状态，不把部分行回填当成功。SQLite 先在副本测试，失败可丢弃测试副本；真实 SQLite 若将来使用，应在迁移前保存可恢复文件副本并测试恢复。
- 应用发布需回退时，先停止新 writer/读进程，使用旧代码；可暂留新增影子列，旧代码读取原文即可运行。若允许旧代码重新写入，则再次升级前必须重算全部影子，不能信任已有非空值。
- 只有所有依赖新列的进程已退出后才执行 downgrade。downgrade 仅移除两列及本次附属约束，不改原文、锚点、版本、审计或文件；再次 upgrade 从原字段可重建。回滚不需要重新解析、重新切片或调用模型。

## 成本与独立索引评估

只读统计当前整个评估库，**含其他验收 fixture**：1953 条 Document、2354 条 DocumentChunk；两份规范化文本约 2,553,791 UTF-8 bytes，不含行/TOAST/索引开销。这个数字不是 CMRC 848 文档，也不是某个中英合并语料的固定大小。部署前需要重新统计实际目标库。

成本为额外文本存储、每次源字段写入的线性归一化 CPU、一次回填及迁移锁窗口。当前 `%substring%` 本来就不能直接依赖普通 B-tree；本次不自动添加 trigram/全文索引。若之后测到扫描瓶颈，再以独立基线评估 pg_trgm、短 term 行为、候选排序、索引体积与写入成本。
