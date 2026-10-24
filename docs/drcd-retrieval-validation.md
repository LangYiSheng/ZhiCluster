# DRCD 繁体中文来源检索基线

日期：2026-10-24。

为减少只围绕既有 CMRC 失败样本优化的风险，新增 [台达 DRCD 官方公开验证集](https://github.com/DRCKnowledgeTeam/DRCD) 作为额外对照。官方声明许可为 CC BY-SA 3.0；原始资料来自维基百科，使用时保留来源说明。本轮未将原始语料或逐题结果提交到 Git。

## 数据与方法

- 官方原文件：[DRCD_dev.json](https://raw.githubusercontent.com/DRCKnowledgeTeam/DRCD/master/DRCD_dev.json)，版本 1.3，2,184,379 字节。
- SHA-256：`e236df03861ba241bd7b29628cd48b3b8e339c60137e041a4358b5320ed61928`。
- 383 篇文章下的 1,000 个不同上下文，3,524 个唯一问题；逐题至少一个标注答案存在于对应原文。
- 保留原始繁体文本，不作繁简转换，不将正确文章标题加入问题；每个上下文单独上传为 Markdown，标题仅作为文档正文的一部分。
- 使用独立评估项目的 API 18000、数据库 25432 和独立上传卷。模型连接关闭，真实上传 1,000 份资料并等待 worker 正文解析就绪，耗时 87.688 秒。
- seed=20261024，对全部 3,524 题固定排序评估，limit=30、关键词模式、关闭模型重排。首份完整基线镜像为 `sha256:ee75beff5fc7e81405abdb45d9bbf485583d9cd4e773257e2974b9e989e69539`。

沿用 CMRC 的来源定义：返回文档去重后计算来源 Recall/MRR；前五证据需同时来自正确上下文且包含任一标注答案。结果不是官方抽取式阅读理解 EM/F1，也不代表模型回答质量。

## 完整真实 API 基线

| 指标 | 3,524 题基线 |
| --- | ---: |
| 来源 Recall@1 | 0.927072 |
| 来源 Recall@5 | 0.984393 |
| 来源 Recall@10 | 0.992338 |
| 来源 MRR@10 | 0.952396 |
| 前五片段答案证据覆盖 | 0.980136 |

本机观测 HTTP 中位数约 297 ms、p95 约 547 ms；同时存在其他测试负载，不作为普遍性能保证。原始结果为 `.data/drcd-holdout/drcd-cte-baseline.json`，精确资料 ID 与 fixture 名称保存在同目录的 `drcd-state.json`。

评估脚本增加 `--dataset-name drcd`，按所选数据源校验 SHA，使用独立状态与结果前缀；默认 CMRC 路径和已有断点继续使用原数据身份。数据加载与指标回归 6 项通过，DRCD 完整真实链路已完成；后续候选对照使用先前冻结的源码和完整逐题配对，不据本集结果调整候选阈值。

```powershell
$evalImage = (docker inspect zhicluster-eval-api-1 --format '{{.Image}}').Trim()
backend/.venv/Scripts/python scripts/benchmark_cmrc.py --dataset-name drcd --workdir .data/drcd-holdout --url http://127.0.0.1:18000 --queries 3524 --label cte-baseline --revision $evalImage
```

已有同名完成结果时应换标签，存在匹配的未完成断点时使用 `--resume`，并保持相同 API 镜像。没有改写日常资料、模型设置或索引。
