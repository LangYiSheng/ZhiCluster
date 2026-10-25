# 文档格式支持与扩展

当前支持15个扩展名（HTML与HTM共用同一解析器）。读取流程为：上传类型与内容校验 → 格式解析器 → 统一章节和来源锚点 → 切块、检索与问答；阅读器使用这些章节，原始文件始终保留。

| 文件 | 提取及来源定位 | 阅读方式 |
| --- | --- | --- |
| PDF | 已有文本层、标题、真实页码 | 原件画布或文字 |
| DOCX / DOC | 标题、段落、表格；段落范围 | 结构正文 |
| MD / TXT | 标题、代码块、文本；真实行号 | Markdown或纯文本 |
| PPTX / PPT | 幻灯片标题、文本、表格、备注；幻灯片号 | 按幻灯片分节的正文 |
| XLSX / XLS | 工作表、单元格数据；表名与行范围 | 按工作表分节的正文 |
| CSV | 解析引号、多行单元格和中文编码；记录行范围 | 结构文本 |
| HTML / HTM | 静态正文与标题；可阅读段落 | 安全文本 |
| JSON / JSONL | 结构化数据与记录；记录范围，JSONL物理行号 | 格式化文本 |
| EPUB | 按书籍spine顺序提取；章节名与包内路径 | 按章节分节的正文 |

非PDF不承诺还原Word、PowerPoint或Excel的完整排版，可下载原件。XLSX公式保留为文字，XLS读取缓存计算值；均不执行计算、宏或嵌入对象。HTML/EPUB不运行脚本，不请求外部网页、图片或样式。扫描PDF、纯图片页的OCR不在当前范围；加密文档、宏文档和DRM书籍会给出明确错误。

## 运行依赖

标准Docker镜像已包含全部解析依赖、LibreOffice Writer/Calc/Impress和系统Python UNO。DOC/PPT使用随机私有pipe、独立用户配置及临时文件，通过UNO明确设置`MacroExecutionMode.NEVER_EXECUTE`、`UpdateDocMode.NO_UPDATE`、只读和隐藏载入，45秒转换超时清理整组进程，不修改原件。

主机直接运行时`uv sync --frozen`安装Python解析器；缺少Linux LibreOffice/UNO时，DOC/PPT会在能力接口与上传入口明确显示不可用。不要把改后缀当作格式转换。

## 扩展一个格式

1. 在`backend/app/ingestion/`新增解析模块。校验函数接收bytes和解压上限；解析函数返回`parser_types.py`定义的`ParsedDocument`，包含`ParsedSection`、全文、元数据。
2. 为每节提供真实锚点与可验证的`source_start/source_end`；不要伪造页码或段落位置。全文切片必须与节正文一致。
3. 在`format_registry.get_registry()`注册一个`FormatSpec`：扩展名、名称、标准及可接受MIME、校验、解析、预览类型和依赖能力。上传与前端能力列表自动采用该描述符。
4. 添加真实文件、损坏/伪装内容、体积与活动内容边界测试。新增不同类型的锚点或专用原件预览时，再增加对应阅读器支持。

`GET /api/settings/file-formats`是运行时能力的唯一入口，返回格式列表、可用状态、原因和上传限制。PDF使用原件预览，其余当前使用安全结构正文。长文档阅读每组最多渲染40节，并允许引用自动跳至目标组，避免一次铺开上千节。

## 验证

- 离线后端全量首轮435 passed、72 skipped、16 xfailed；前端32文件182项全过，类型检查、ESLint及Ruff通过。
- 最终解析/注册表/旧Office定向43项通过，其中现代格式和安全边界28项；另有UNO参数、超时与后台流程专项验证。
- 无网络临时容器中15种真实文件均解析通过，包括由LibreOffice实际导出的DOC/XLS/PPT。
- `frontend/e2e/document-formats.spec.ts`逐一验证15种格式的实际上传、worker解析、关键词搜索、引用跳转、阅读和原件下载，全部通过。下载bytes与上传原件完全一致，HTML脚本未执行且无外部请求。
- 真实样例由`scripts/generate_format_fixtures.py`生成，`--legacy`要求容器中的LibreOffice。样例和验收产物位于`.data/test-runs/`，不堆积项目根目录。

独立验收站点为`http://localhost:13001`。2026-10-25用户明确确认后，已使用同一批验收镜像更新日常`http://localhost:3000`。日常能力接口确认15种格式全部可用，API/worker运行正常；原有11份资料的下载大小与SHA256全部核对一致。日常站点仅进行只读验收，完整15格式写入链路在隔离站点验证。
