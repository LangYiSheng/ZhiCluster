# 检索候选 SQL 剖析与只读减重实验

日期：2026-10-24。候选 ID / 分数 CTE 重构已应用到主机检索源码，并完成下面的范围门禁和只读对照；本次子任务没有重建 API，API revision 和完整 API 回归由主任务另行记录。实验对象是隔离评估 PostgreSQL `127.0.0.1:25432/zhicluster` 中的 CMRC2018 专用知识库：848 份文档、1,027 个片段。

所有实际语料剖析均在 `SET TRANSACTION READ ONLY` 下运行，并用 `SHOW transaction_read_only=on` 校验。只执行 SELECT 和只读 `EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)`，不修改 schema，不执行表级 ANALYZE，不增加索引，不接触日常数据库或配置。向量/标签专项使用独立 `zhicluster_ingestion_test` 的事务内合成数据，结束后回滚。

## 先定位瓶颈

固定随机种子 20261024 选取 12 条 CMRC 问题，每题执行两次，用 SQLAlchemy 事件区分数据库 execute 往返与本地阶段耗时。以下是第二次运行的平均值：

| 阶段 | 动态预算快照 | 主机 600 / 100 + 同分分散源码 |
| --- | ---: | ---: |
| 总请求 | 183.714 ms | 182.771 ms |
| 候选 SQL、取数与实体加载 | 142.304 ms | 144.406 ms |
| 两次本地词面打分合计 | 15.316 ms | 15.103 ms |
| 等待后的访问范围复核 | 13.280 ms | 13.714 ms |
| 初始范围校验 | 2.282 ms | 2.182 ms |
| 多样性排序 | 2.029 ms | 2.135 ms |

这些问题的候选数量都未达到旧预算上限，因此扩大预算对这组问题几乎没有影响。主机源码和运行中 API 的容器版本分别由各自证据确定，不能把主机剖析当成 API 的版本或延迟验证。

当前 600 分支约 79% 的时间落在候选获取阶段。慢样本含 19–23 个查询词，EXPLAIN 的规划时间约 40–73 ms、执行约 127–175 ms，Shared Read Blocks 为 0。大部分数据已经在 PostgreSQL 缓存里，多样性排序只占约 1%。这组证据不支持优先增加索引或继续优化多样性函数。

候选 SQL 在窗口子查询和外层重复了 scope、ILIKE/CASE 相关性及文件夹检查；外层按原表达式排序时又计算相同相关性。单纯统计扫描节点数量不足以定位这个开销。

## 只读可信快照方案

临时实现保持 600 总池、每文档 100、主相关性优先、同相关性内按文档候选序号分散，及模型等待后的权限复核：

1. 在带完整范围过滤的窗口 CTE 中计算候选 ID、主分数和文档内序号。
2. 对这些标量结果过滤文档上限、排序并截取候选池。
3. 按已经确定的 ID 一次连接原片段/文档实体，使用已经计算的主分数排序；外层不再重复范围或 ILIKE/CASE 表达式。

这是一条候选 SQL，没有把“计算 ID”和“取实体”拆成两次存在竞态窗口的数据库请求。先行实验只加载临时快照，确认收益后才应用相同结构到正式源码；固定 600 / 100 和同分分散保持不变。

## 同题交错比较

用同 12 条问题，每题当前/临时各运行三次，交错执行顺序，共 72 次。在同一个只读连接上比较全部 items、total、mode、notice、kb_ids 的 SHA-256 签名，全部一致。EXPLAIN 在计时循环之后单独执行，避免给其中一个方案额外预热。

| 指标 | 当前 600 分支 | ID / 分数 CTE 快照 |
| --- | ---: | ---: |
| 总耗时中位数 | 198.452 ms | 161.165 ms |
| 总耗时均值 | 192.354 ms | 157.165 ms |
| 候选获取均值 | 151.369 ms | 117.950 ms |
| 候选 execute 往返均值 | 142.951 ms | 111.956 ms |
| EXPLAIN Planning 均值 | 33.220 ms | 16.320 ms |
| EXPLAIN Execution 均值 | 103.010 ms | 89.750 ms |

服务器规划和执行耗时均下降，说明收益不只是把 Python 解析工作换了位置。最后一次实体加载仍可能出现一次便宜的 chunk 顺序扫描；没有宣称消除了所有扫描，也没有把小语料、同机缓存下的观测推广为大规模普遍加速比例。

## 快照行为门禁

临时模块加载后共 109 项相关回归通过，包括 SQLite 检索/分页/聊天范围、真实 PG 分页及受控向量准入。另加一个 PG 综合范围样本，明确检查：

- tag all 只返回两个共同标签的文档，tag any 扩大到任一标签。
- 未选目录、跨知识库、软删除文档和旧 embedding profile 被排除。
- 非并列 cosine 距离仍按升序取最相近证据，主相关性不会被文档分散覆盖。
- 原访问权限/资料变化复核、标签和 folder 范围回归仍通过。

## 正式工具与主机实现复核

`scripts/retrieval_profile.py` 将前置实验整理为可复现工具：连接只从专用 `PG_RETRIEVAL_PROFILE_URL` 环境变量读取，不读取 `.env`；只接受 loopback 的 25432/zhicluster，或通过 `--test-database` 明确选择并匹配的 `*_test` 数据库。拒绝远程主机、普通数据库、隐式专库和 URL query 中的 host/service/options 等路由覆盖。

正式工具强制只读事务并验证状态，关闭聊天及向量连接，校验实际库中 CMRC fixture 的原名称/ID及语料 SHA；旧/新快照源码按实际编译字节记录 SHA，运行结束后复核文件未变。每题交错旧/新三次，签名比较除 elapsed_ms 之外的全部响应字段；不一致或源码变化会保存报告并返回非零状态。EXPLAIN 在测量循环之后执行，结果文件拒绝覆盖；报告不保存连接 URL、用户名、密码或驱动错误详情。

在私有终端预先设置专用连接环境变量后，从仓库根目录运行：

```powershell
backend/.venv/Scripts/python scripts/retrieval_profile.py --baseline-source .data/retrieval-benchmark/candidate-budget/host600baseline --candidate-source backend/app/retrieval --queries 12 --repeats 3 --output .data/retrieval-benchmark/profile-reviewed.json
```

参数指定的是可信本地 Python 源码目录；工具会执行其中的 terms/ranking/search.py，不应把不可信下载内容当作快照。可用 `--queries 2 --repeats 1 --no-explain` 做快速通路检查。

正式工具对实际主机 CTE 源码再次完成 72 次交错请求，所有响应签名和源码哈希复核通过，包含 24 份 EXPLAIN：

| 指标 | 600 旧 SQL 快照 | 主机 CTE 实现 |
| --- | ---: | ---: |
| 总耗时均值 | 164.381 ms | 140.296 ms |
| 候选获取均值 | 132.206 ms | 108.301 ms |
| EXPLAIN Planning 均值 | 31.306 ms | 15.913 ms |
| EXPLAIN Execution 均值 | 97.084 ms | 82.047 ms |

不同轮次有缓存和后台负载差异，因此保留每轮观测，未把某一轮数据混作另一轮的前后值。

主机正式实现的聚焦检索/分页/聊天及工具 guard 共 126 项通过；专用 PG 的 scope/分页/排序门禁 6 项通过，设置每条语句 15 秒上限，整组耗时约 9.70 秒。guard 中 22 项覆盖目标库限制、路由绕过、响应签名与源码变化。新增正式 PG 测试还覆盖空候选、额外 where 谓词，以及旧 profile 为不同向量维度时仍被排除。

此前旧 SQL 的一次 combined PG 6 项虽然最终通过，但耗时 395.18 秒，同时间专库观察到一条长时间活跃、无锁等待的检索 SELECT。未采集该次完整执行计划，不能将其确定归因为某个坏计划；也不将这组测试总时长与新的 9.70 秒作“40 倍提速”宣传。没有停止其他连接或通过清库规避该观察。

## 范围与一致性审查

- 原 stmt 的 join/where 全部保留在 scoped_candidates 中，包含知识库、目录、标签 all/any、文档、日期、类型及当前向量 profile；外层只能读取已准入的全局唯一 chunk ID。
- 候选筛选与实体读取在同一 SQL 语句快照内完成。模型等待后的 `_current_candidates()` 仍重新查询权限和范围，没有把慢请求的旧权限冻结成永久授权。
- 词面分数保持降序，cosine 距离保持升序。同分内的文档序号和片段 ID 仍作为后续排序键，不能把文档分散放到主相关性之前。
- 空 CTE 不会展开成全库结果；额外调用方谓词进入内层候选范围。真实 PG 专项分别验证这两条边界。
- 这是单次搜索 SQL 的等价重构，不是跨资料/配置变更的搜索快照。分页和可选 LLM rerank 的非稳定边界仍见[分页验收](retrieval-pagination-validation.md)。

原始分阶段结果与 EXPLAIN 位于忽略目录 `.data/retrieval-benchmark/cmrc-profile-*.json`；先行交错对照是 `cmrc-profile-scoped-ids-interleaved.json`。正式工具的完整快照复现为 `formal-profile-full-1792840969655.json`，实际主机源码复核为 `formal-profile-product-1792841481732.json`。这些只读/专项结果不能替代完整前后端及真实 API 回归，最终统一门禁由主任务记录。
