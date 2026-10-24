# 文件夹与文档管理规模回归

日期：2026-10-24。只使用内存 SQLite 合成元数据，以及独立 Docker 评估数据库中的 `zhicluster_ingestion_test`。没有调用模型、修改日常知识库或读取用户原件。

## 问题与改进

- 目录子树展开原先每增加一层都扫描整个知识库的目录，深链会形成二次增长。现在只读目录 ID/父 ID，建立一次邻接表后用队列遍历，时间为目录总数与子树节点数的线性量级；不实例化全部 ORM 目录对象。已删除节点不参与展开，非法、跨库及已删除起点继续拒绝。
- 文档列表原先逐文档查询标签。现在对当前分页一次批读关联，再合并原有字段；空页不额外查询标签，分页、筛选和总数语义保持原样。
- 文件夹子树软删除原先逐份调用单文档更新，重复取得知识库锁、读取文档和标签。现在先取得知识库命名空间锁，按 ID 批量锁定当前子树中的活动文档，批读标签后更新，并保留每份文档独立的版本与 before/after 审计。源文件、标签关联和显式恢复顺序保护均保留。
- 文件夹名称、文档名称或标签列表显式传 `null` 原先可进入业务层并触发未处理的 `AttributeError` / `TypeError`。现在返回 400，清楚说明无效输入；空标签列表仍用于清除标签，`folder_id: null` 仍用于移动到根目录。失败事务保留原名称、版本和标签。

## 可复现合成基准

使用 `scripts/library_benchmark.py`，固定 3,000 层目录、200 份文档，每份关联同一标签，执行 5 次。每次使用新 Session；删除后回滚，下一次仍使用相同数据。脚本强制内存 SQLite，不接受外部数据库连接。

```powershell
backend/.venv/Scripts/python scripts/library_benchmark.py --output .data/library-benchmark/after.json
```

原实现取自提交 `8ec360d1c3c76918a8dda4002656724c0f00fffe` 的 `services/library.py` 与 `api/library.py`，在同一脚本中加载原函数运行；完整对照保存在忽略目录 `.data/library-benchmark/before-complete.json`，最终实现结果在 `after.json`。第一次只含子树展开和列表的旧基线另存为 `before.json`，不混入下表。

| 操作 | 原实现 5 次中位 | 当前实现 5 次中位 | SELECT 次数 |
| --- | ---: | ---: | --- |
| 展开 3,000 层目录子树 | 2,838.095 ms | 6.145 ms | 均为一次目录批读 |
| 读取一页 200 份文档和标签 | 32.138 ms | 7.427 ms | 205 → 6；标签 200 → 1 |
| 软删除 3,000 目录与 200 文档子树 | 3,375.364 ms | 211.591 ms | 1,209 → 10；标签 400 → 1 |

这些时间只代表本机合成元数据、内存数据库与当时负载，不等同真实 PostgreSQL 网络延迟、百万文档规模或文件解析速度。查询次数、返回内容及审计完整性由独立回归测试验证；不把一次合成计时外推为整个系统的普遍加速比例。

## 正确性与真实 PostgreSQL 并发

新增 `test_library_scale.py` 覆盖：200 文档标签批读，1,500 层目录、多起点、删除分支与跨库隔离，200 文档子树软删除的版本/标签/审计完整性，先恢复父目录的保护，以及 4 种无效元数据更新（含先改名后遇到无效标签的事务回滚）。原实现先运行测试，实际复现了 200 次标签读取、1,209 次子树删除 SELECT 和 3 类未处理空值异常，再实现修复。

新增 `test_library_scale_postgres.py` 在端口 25432 的独立评估容器、明确后缀的专库运行，2 项通过：

1. 删除等待知识库锁期间，另一事务把一份文档移出待删子树并提交：删除事务取得锁后使用最新成员，39 份子文档软删除，移出的 1 份保留；40 份原标签关联保持，删除审计只有 39 条。
2. 文档恢复等待另一事务提交子树删除：恢复事务读取最新状态，返回 `invalid_folder`，文档保持已删除且版本没有额外增加。

```powershell
# 事先将 PG_INGESTION_TEST_URL 设置为隔离专库的连接串，数据库名必须为 zhicluster_ingestion_test。
cd backend
.venv/Scripts/python -m pytest tests/test_library_scale_postgres.py -q -p no:cacheprovider
```

测试严格检查专库名称，保留可检查的合成记录。SQLite 不提供 PostgreSQL 行锁语义，因此只用上述两项真实数据库测试支持并发结论。

最终聚焦回归 `test_library_scale.py`、`test_library_api.py`、`test_trash.py`、`test_agent_metadata_deletion.py`、`test_agent_api.py` 与 `test_security_review.py` 共 48 项通过、1 项跳过（当前 Windows 账户不支持符号链接创建）；真实 PostgreSQL 专项另外 2 项通过。涉及文件的 Ruff 检查通过。完整项目回归由本轮集成统一执行，这里不把聚焦结果标记为完整系统验收。
