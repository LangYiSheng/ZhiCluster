# 元数据资源在锁等待期间消失的处理

日期：2026-10-24。使用独立评估容器中的 `zhicluster_ingestion_test` 和内存 SQLite；没有修改日常知识库、调用模型或重建服务。

## 最小复现与影响

一个修改或恢复请求先读到文档、目录、标签或知识库，随后等待知识库行锁。另一事务持有该锁，通过现有软删除与 `purge_trash` 永久清理文档/目录/知识库，或通过标签删除接口删除标签后提交。等待中的请求取得锁时，最初读取的 ORM 对象已不代表仍存在的资源。

原实现的文档/目录更新在新查询返回 `None` 后继续构造快照，触发 `AttributeError`；其他分支对旧对象执行 `refresh`，触发 `InvalidRequestError: Could not refresh instance`。这些异常会返回 500，用户无法分辨资源已被其他操作清理。

新增真实 PostgreSQL 参数化回归先复现最初 5 条分支全部失败。扩展核查剩余同类分支时，目录删除和知识库修改/删除/恢复另外 4 条同样失败。

## 实现范围

统一使用 `lock_metadata_entity` 重新执行 `SELECT ... FOR UPDATE`，刷新身份缓存，缺失资源直接返回 `not_found / 404`。对于文档、目录和标签，查询同时限定已经锁定的知识库 ID。

覆盖 9 条逻辑分支：

- 单文档更新服务，供文档修改、移动、标签更新、回收和恢复使用。
- 目录更新、恢复、删除。
- 标签更新、删除。
- 知识库更新、删除、恢复。

知识库管理操作先检查管理权限，再取得当前知识库行锁，随后重新检查删除状态和管理权限。等待期间知识库被软删除，修改请求返回 404；管理权限被收回，返回 403。显式版本校验在读取当前行后执行，过期版本继续返回 409。名称冲突、父目录校验、标签关联及事务审计沿用现有处理。

命名空间锁本身也复用同一行锁读取，并检查返回值。曾经缓存知识库的 Session 等待整库清理后，不能通过身份缓存继续使用旧知识库，再因成员记录消失误报 403；现在直接返回资源不存在的 404。这里替换原有的同一次行锁查询，未增加数据库查询。

批量更新服务、检索、前端和接口结构保持原样。实现针对查询确认资源不存在的情况返回 404，不将其他数据库异常统一解释为资源删除。

## 验证

新增 `tests/test_metadata_disappearing_postgres.py`：

1. 9 种资源消失场景：请求已经读取资源并阻塞于知识库锁，另一事务使用实际删除/清理逻辑提交；迟到请求均返回 404。
2. 文档、目录、标签、知识库 4 种显式版本冲突：等待期间另一事务完成改名，迟到请求返回 409，并保留已提交的新名称与版本。
3. 知识库 2 种锁后状态变化：软删除和管理权限收回分别返回 404、403，未写入迟到的改名。
4. Session 强引用缓存知识库，子文档修改等待命名空间期间另一事务实际永久删除整库：请求返回 404。该用例先复现了旧实现错误返回 403，再验证修复。

该文件 16 项通过；连同已有批量管理、目录管理和元数据删除并发专项，真实 PostgreSQL 共 **26 项通过**。

聚焦离线回归覆盖文档 API、目录规模、批量管理、回收站、安全、Agent 元数据删除和 Agent API，共 **65 项通过、1 项跳过**。跳过项是当前 Windows 账户不支持创建符号链接。涉及文件 Ruff 与 diff 空白检查通过。

```powershell
# 事先将 PG_INGESTION_TEST_URL 设置为独立专库连接，库名必须为 zhicluster_ingestion_test。
cd backend
.venv/Scripts/python -m pytest tests/test_metadata_disappearing_postgres.py tests/test_library_batch_postgres.py tests/test_library_scale_postgres.py tests/test_metadata_deletion_postgres.py -q -p no:cacheprovider
.venv/Scripts/python -m pytest tests/test_library_api.py tests/test_library_scale.py tests/test_library_batch.py tests/test_trash.py tests/test_security_review.py tests/test_agent_metadata_deletion.py tests/test_agent_api.py -q -p no:cacheprovider
```

PostgreSQL 专项严格校验数据库名称，使用每个测试独立的合成用户和知识库。SQLite 回归不用于证明行锁行为；真实锁等待结论由 PostgreSQL 测试支持。完整项目回归与服务交付由集成阶段统一执行。
