# 持续优化阶段记录

开始日期：2026-10-24。目标仍在进行中；用户说结束后再汇总最终报告。本文件记录已完成验证的阶段，不把待办写成成果。

## 隔离与数据

日常站点继续使用 3000/8000。评估采用独立 Compose 项目 `zhicluster-eval`，网页 13000、API 18000、数据库 25432，数据库/上传/配置卷独立；明确不继承 `.env` 中的模型连接。首次浏览器验收因评估来源未加入白名单而出现 403，已在评估配置中只加入两个本机 13000 来源，没有放宽日常站点来源保护。

```powershell
docker compose -p zhicluster-eval -f compose.yaml -f compose.eval.yaml up --build -d
backend/.venv/Scripts/python scripts/benchmark_cmrc.py --download --label baseline
# 构建被测版本后，同一库、相同问题和参数复测：
backend/.venv/Scripts/python scripts/benchmark_cmrc.py --label optimized
```

脚本只允许 13000/18000 本机端口，检测模型连接均未配置后才执行。首次创建的库和精确文档 ID 保存在 `.data/continuous-optimization/cmrc-state.json`，便于重复测试和精确清理。不要在评估站点保存模型连接。测试期间保留该库供后续规模回归，不修改日常资料。

公开语料原文不进入 Git：

- 英文 SciFact 5,183 篇、300 条正式 test 查询；NFCorpus 3,633 篇、323 条正式 test 查询。来源、许可证、训练对照与失败样本分布见[英文检索验收](retrieval-benchmark-validation.md)。
- 中文 [CMRC2018 官方仓库](https://github.com/ymcui/cmrc2018)，[开发集原文件](https://raw.githubusercontent.com/ymcui/cmrc2018/master/squad-style-data/cmrc2018_dev.json)，CC BY-SA 4.0。SHA-256：`e9ff74231f05c230c6fa88b84441ee334d97234cbb610991cd94b82db00c7f1f`。

CMRC2018 的 848 个不同上下文各转换为一份 Markdown，以原文章标题作为正文标题，文件名使用内容哈希。它原本是阅读理解集，本轮把问题的所属上下文视为相关文档，测试的是来源检索，不是官方抽取式阅读理解分数。脚本通过真实 HTTP 上传、后台 worker 解析和切片，再调用关键词搜索；不生成模型答案。

## 已验证的检索结果

中文从全部 3,219 个问题中按种子 20261024 固定抽取 300 条，前后均使用相同的 848 份资料、30 个返回 chunk、关闭向量与模型重排。按返回文档去重计算 Recall/MRR；答案证据要求命中原文档且前五个 chunk 中包含任一标注答案，不能用其他文档的同词充数。独立手算回归覆盖去重、错误来源、十名边界与备选答案。

| 指标 | 基线 | 第一轮优化 |
| --- | ---: | ---: |
| 首位文档命中率 | 0.970000 | 0.970000 |
| 前五文档命中率 | 1.000000 | 1.000000 |
| MRR@10 | 0.984167 | 0.984167 |
| 前五 chunk 答案证据命中率 | 0.993333 | 0.993333 |

首次 848 份资料上传并达到正文可检索状态耗时 143.921 秒。两次 HTTP 关键词搜索观测的中位数为 250 / 219 ms，P95 为 625 / 516 ms；同时有其他测试负载、缓存和后台任务差异，不据此宣称普遍加速比例。原始逐题结果位于 `.data/continuous-optimization/cmrc-baseline.json` 与 `cmrc-optimized.json`。

SciFact 与 NFCorpus 的六个汇总质量指标均有小幅提高，但仍存在逐题退步。多样性排序则与旧实现逐项等价，减少了无关文档之间的重复扫描。详见独立检索验收；本轮没有真实向量模型评估，不能称已解决语义召回或完整 RAG 质量。

## 已提交的管理与检索优化

- `ca0a355`：目录邻接遍历、分页标签批读和子树软删除批量锁定，保留逐份审计与版本。合成数据的 SQL 次数及真实 PostgreSQL 交错事务见[管理规模验收](library-management-validation.md)。
- `ffe53e2`：英文停用词、多样性堆排序与按知识库合并目录范围展开，附公开数据基准脚本和验收说明。
- `b6bfcea`：目录上传与选择完整性、失效范围恢复、深目录和移动路径，以及任务历史分页、准确统计与当前文档状态查询，附 7 条真实浏览器流程验收。

## 正在集成与下一轮

前端拖放目标与重复副本目录、分页选择与缓存、失效目录恢复、并发上传确认、深层目录和移动路径已修复。任务分页、准确统计与当前文档状态也已完成，848 条历史可完整访问。集成回归为后端 338 passed / 29 skipped、前端 114 passed、串行浏览器 7 passed，详见[管理交互与任务验收](management-integrity-validation.md)。

下一轮在评估检索 API 分页的稳定性：当前候选预算随 limit/offset 改变，在静态资料上也可能造成跨页重复。已建立公开数据和长文档压力对照，尚未把实验参数当作正式运行结果；需同时权衡召回质量、长文档候选覆盖与耗时。
