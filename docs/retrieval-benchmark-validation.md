# 公开检索数据集基线与第一轮优化

日期：2026-10-24。原始代码基线为 `8ec360d` 的检索模块。本轮使用独立内存 SQLite，不读取日常知识库，不调用聊天或向量模型，不写入已保存的模型配置。此处评估的是关键词检索分支；真实文件上传与 PostgreSQL 的中文验收另行记录。

## 数据来源与可复现范围

- [BEIR 官方数据清单](https://github.com/beir-cellar/beir#beers-available-datasets)提供下载链接和原始 MD5。[官方镜像目录](https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/)中的 SciFact ZIP 为 2,816,079 字节，NFCorpus 为 2,448,432 字节。
- SciFact：5,183 篇摘要，正式 test 的 300 条有标注查询。先以 train 按 query ID 排序的前 60 条比较方案，之后完整 test 验证；没有从 test 中挑选展示样本。
- NFCorpus：3,633 篇摘要，正式 test 的全部 323 条有标注查询。作为第二份语料交叉验证。
- [SciFact 原始许可证](https://github.com/allenai/scifact/blob/master/LICENSE.md)：主张和证据标注为 CC BY 4.0，摘要为 ODC-By 1.0；[BEIR 的 SciFact 卡](https://huggingface.co/datasets/BeIR/scifact)及[NFCorpus 卡](https://huggingface.co/datasets/BeIR/nfcorpus)标注 CC BY-SA 4.0。保留两层来源与许可，不把基准代码许可证当成语料许可证。语料不进入本仓库 Git。

`scripts/retrieval_benchmark.py` 校验官方压缩包长度和 MD5，并把 SHA-256、语料规模、每条查询结果、指标和耗时保存到忽略目录 `.data/retrieval-benchmark/`。最终脚本还记录实际加载的 `terms/ranking/search.py` 内容哈希；可用 `--source-dir` 加载可信的旧版模块快照进行同机比较。

每篇摘要直接作为一个 chunk，标题按当前模型的 255 字符上限截断。评估调用产品的 `search_knowledge()`，包含真实候选 SQL、词面排序、融合、用途先验、多样性和访问范围复核。未经过文件解析/切片，也未配置语义模型，不能把结果描述成完整 RAG 或混合检索基准。

## 问题与变更

1. 英文自然语言中的 how/can/in/the 等常用词参与候选打分，多个无关片段可能在有限候选池中挤掉真正证据。增加通用英文停用词过滤，保留完整原句与仅由停用词构成的字面查询；不增加主题词典或模型请求。新增 170 个干扰文档的回归，在真实候选上限下检查证据仍排在第一位。
2. 多样性排序每轮扫描全池选下一条，再扫描全池寻找同文档片段。改用堆维护每份文档的当前最佳候选，只在选中片段后更新该文档的剩余兄弟片段。堆大小受文档数量限制，不累计长文档的失效优先级条目。重复折扣、文档计数、稳定并列顺序及引用锚点保持相同，固定随机输入与旧算法进行完整顺序对照，包含 600 个片段都来自同一文档的压力样本。
3. 一次搜索选择多个文件夹时，原来每个起点各读取一次全目录树。配合 `descendants()` 的邻接遍历，按知识库合并起点后扩展；网络等待后重新读取选中的根目录和当前 parent ID，避免再次把整库目录加载为 ORM 对象。10 个起点带子目录的回归验证结果范围不变，目录独立 SELECT 数固定为 4；关闭包含子目录时为 2。

训练集比较中曾尝试短英文标识符的严格词边界。60 条训练查询的 MRR 由停用词版 0.70486 降至 0.69653，因此撤销该方案，不纳入最终运行代码。

## 完整 test 结果

所有指标均按文档 ID 去重，在前 10 项计算。Recall 对每条查询的全部正相关文档取比例后平均，MRR 为首个正相关结果的倒数排名，nDCG 使用原标注等级的线性增益；不是只计算“是否有一个命中”。

| 数据集 | 查询数 | 指标 | 原始版本 | 优化版本 |
| --- | ---: | --- | ---: | ---: |
| SciFact | 300 | Recall@10 | 0.703944 | 0.719778 |
| SciFact | 300 | MRR@10 | 0.576668 | 0.580546 |
| SciFact | 300 | nDCG@10 | 0.602253 | 0.608700 |
| NFCorpus | 323 | Recall@10 | 0.131118 | 0.133412 |
| NFCorpus | 323 | MRR@10 | 0.454236 | 0.469669 |
| NFCorpus | 323 | nDCG@10 | 0.274954 | 0.279818 |

这是一轮小幅、跨语料的关键词质量提升。按每条查询的 nDCG 比较，SciFact 中 21 条提高、15 条降低、264 条不变；NFCorpus 中 29 条提高、16 条降低、278 条不变，因此并非每个问题都提高。NFCorpus 的 Recall@10 仍低，原始版本中 22 条查询完全无关键词命中，提示仅靠词面无法解决语义同义表达；未把缺少向量模型的结果包装成已解决语义召回。

首次完整运行观测到的中位耗时：SciFact 618.655 → 375.080 ms，NFCorpus 172.500 → 85.310 ms。这些运行期间存在其他基准/测试任务，不能据此给出普遍系统加速比例。另一次同机顺序运行的固定 60 条 train 观测为 672.405 → 327.180 ms，仍只适用于本机和该查询集。

对多样性排序单独做 7 次重复取中位数，输入与输出顺序逐项比对一致：

| 候选数 | 每文档片段数 | 旧实现中位数 | 堆实现中位数 |
| ---: | ---: | ---: | ---: |
| 160 | 1 | 15.369 ms | 0.142 ms |
| 160 | 20 | 15.186 ms | 10.549 ms |
| 600 | 1 | 112.762 ms | 0.617 ms |
| 600 | 20 | 108.621 ms | 57.405 ms |
| 100 | 100 | 11.137 ms | 9.883 ms |
| 600 | 600 | 147.953 ms | 105.689 ms |

微基准只度量多样性函数；数据库扫描、网络模型延迟和多进程负载不包含在这些数值内。

## 复现命令与证据

在仓库根目录运行：

```powershell
backend/.venv/Scripts/python scripts/retrieval_benchmark.py --dataset scifact --download --label current
backend/.venv/Scripts/python scripts/retrieval_benchmark.py --dataset nfcorpus --download --label current
# 本轮已保留的原始检索源码快照：
backend/.venv/Scripts/python scripts/retrieval_benchmark.py --dataset scifact --source-dir .data/retrieval-benchmark/baseline-sources --label baseline-replay
```

本机 Python 对下载站证书链校验失败，首次下载使用 PowerShell `Invoke-WebRequest` 的系统 TLS；没有关闭证书校验。脚本对缓存继续执行相同完整性校验。

```powershell
Invoke-WebRequest https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/scifact.zip -OutFile .data/retrieval-benchmark/scifact.zip
Invoke-WebRequest https://public.ukp.informatik.tu-darmstadt.de/thakur/BEIR/datasets/nfcorpus.zip -OutFile .data/retrieval-benchmark/nfcorpus.zip
```

最终堆实现的聚焦回归 98 项通过，随后加入 600 片段单文档压力样本的多样性回归 5 项通过（其中 4 项与前一组重叠）。覆盖检索质量、堆排序等价、证据筛选、主动检索、聊天进度及多目录范围，包括已有跨库/标签/向量 profile 隔离、等待期间权限撤销与资料移动保护。Ruff 对本轮检索代码、测试和基准脚本检查通过；指标计算用完美/空结果、分级相关性和重复文档四个手算样本复核。完整后端/前端及浏览器验收由主任务统一记录；此文不把未执行的检查算作通过。
