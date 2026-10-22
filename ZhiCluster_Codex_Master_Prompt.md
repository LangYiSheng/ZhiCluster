# 知簇 · ZhiCluster — Codex 总开发提示词

> 产品名称：**知簇 · ZhiCluster**  
> 产品定位：**AI-Powered Knowledge Workspace（面向知识自动组织、检索与多步骤整理的本地优先知识库）**  
> 默认语言：**简体中文**；项目目录、代码、数据库列名、API 字段使用清晰英文。  
> 本任务是一项真正的**端到端实现任务**，不是需求分析、PPT、静态样机或技术方案征求意见。

---

## 0. 你（Codex）的角色与执行原则

你是一名兼具产品设计、React 前端、Python/FastAPI 后端、PostgreSQL、RAG/Agent、DevOps 和测试能力的资深工程师。**请直接在当前工作目录开发并验证完整项目**。

1. **先检查仓库内容**：如果是空目录，从零初始化；如果已有代码，保护现有成果并做增量实现，禁止无理由覆盖/删除已有文件。检查环境中 Python、Node、pnpm、uv、Docker 是否可用。
2. **自主执行**：合理自行决定未规定的实现细节，不要反复提问或仅停留在计划阶段。缺少真实 API Key、Docker 权限或外部服务时，继续实现其余模块、用 mock provider 做自动化测试，在交付报告中准确列出“未做真实联网验证”的项目。不要将 mock 响应伪装成真实 AI 结果。
3. **必须写代码、运行检查、修复错误**：按照本任务的里程碑依次开发，实际执行 lint、typecheck、build、pytest、迁移和可以执行的端到端测试；未运行过的测试不能宣称通过。
4. **禁止伪功能**：所有可见按钮、右键菜单、对话框和页面跳转必须连接真实状态或后端 API；明确延期的功能不要制作能够点击却没有效果的入口。可在单独标明的测试里使用固定数据，但正常 UI、数据库、RAG、Agent 不能靠前端硬编码模拟工作。
5. **依赖保持兼容**：基于实施时可以获取的稳定官方文档选择兼容版本，锁定依赖；不要照搬过期的 LangChain/LangGraph API；遇到不确定的调用方式，以安装版本官方 API 为准并做最小可运行测试。
6. **按优先级做真实实现**：先完成核心纵向链路（上传→解析→管理→检索→问答），再实现完整 Agent 审批，再做高级 UI 细节。若有环境限制，必须留下运行的主要功能、错误原因与明确的未完成清单，不允许用占位实现充数。
7. **安全默认值**：首版单用户免登录仅用于本地 Demo。所有宿主机端口绑定 `127.0.0.1`，不得默认暴露公网；密钥仅保存在后端环境变量；文件下载、全文内容和检索均走服务层的知识库权限检查。
8. **无需额外确认即可推进**：把本文视为已批准的产品设计与技术决策。无需停下来让我选择框架、风格或模块优先级。最终给出已完成内容、启动方式、测试记录、限制与后续建议。

## 1. 产品边界与技术栈（已决定，不再讨论）

### 1.1 技术栈

- **平台**：Web 应用，前后端分离，桌面浏览器优先。
- **前端**：React + TypeScript + Vite + React Router；shadcn/ui + Tailwind CSS + Lucide React；TanStack Query（远端状态）、Zustand（UI 状态）；按实际情况使用 `@dnd-kit`（拖拽）、`react-pdf` / PDF.js（PDF 阅读）、`react-markdown` + GFM（Markdown 预览）、Sonner（反馈）。严格类型检查。
- **后端**：Python + FastAPI + Pydantic v2 / pydantic-settings + SQLAlchemy 2.x + Alembic；明确区分 API、domain/service、repository、ingestion、retrieval、agent、worker。异步 IO 推荐使用 async SQLAlchemy。
- **数据**：PostgreSQL + pgvector；启用 `vector` 与 `pg_trgm` 等必要扩展；原始附件放后端私有目录/持久化卷；PostgreSQL 保存业务关系、解析内容、索引信息与工作流状态。
- **AI**：云端 **OpenAI 兼容 API**。聊天 LLM 和 Embedding **独立配置**：各自拥有 BASE_URL、API_KEY、MODEL、超时及重试参数，Embedding 另有维度/批处理配置。兼容接口不等于一定支持 Tool Calling，需有显式能力探测与友好错误提示。
- **Agent**：LangChain `create_agent` + LangGraph；用 PostgreSQL checkpointer 保存可恢复工作流状态；Pydantic 验证结构化计划；以 `Plan → Review → Execute` 模式完成**整个整理计划的一次审批**。
- **实时更新**：FastAPI + SSE，提供 AI 回复 token、Agent 步骤和入库任务事件；浏览器端提供断线后的状态重新获取或事件游标恢复机制。
- **部署**：Docker Compose，`web`、`api`、`worker`、`db` 四个常驻服务 + 数据库迁移初始化任务；支持生产式完整启动与**前后端热更新开发模式**。
- **代码质量**：pnpm、Python uv（或等价可复现锁定方案）、ESLint、TypeScript、Ruff、Pytest、React Testing Library/Vitest，Playwright 关键 E2E（环境允许时）。

### 1.2 首版需要实现

1. 单用户本地 Demo，但完整预留未来的 users / knowledge base memberships / roles / 权限检查服务层。
2. 多知识库、多级文件夹、多标签、未分类区、文件批量管理、批量拖拽上传。
3. PDF、DOCX、MD、TXT 入库；解析与元数据持久化；切块/Embedding；**超长文档层级摘要**；AI 分类、标签建议；可重试后台任务。
4. 关键词 + 向量混合检索（RRF 融合）；知识库、文件夹及子目录、标签、文件类型等范围过滤。
5. 真实知识库 RAG、多轮会话、Markdown 流式回答、可点击真实来源引用和位置定位。
6. 自然语言 Agent，能查阅目录/文档/搜索内容、计划创建文件夹、移动文件、设置标签、重命名及软删除；**先展示完整可编辑计划，由用户批准后执行**。高风险操作追加确认；操作审计、撤销。
7. Linear / Notion 式现代效率工具 UI，四区布局、亮暗双主题、可折叠可调整宽度、快捷搜索、批量选择、右键菜单、拖放交互、进度/错误/空状态。
8. Docker 一键启动、本地开发热更新、数据库迁移、示例环境变量、README、必要测试与验收报告。

### 1.3 明确不做（不影响未来架构）

首版**不开发**实际注册/登录/邀请共享成员、不做共享知识库广场、不做 OCR 扫描 PDF、不做 PPTX/Excel/音视频/网页抓取、不做移动端原生应用、不做知识图谱可视化、不做任意 Python/Shell/SQL 执行 Agent 工具、不默认接入其他专用搜索引擎/对象存储/Celery/Redis、不为实现演示而调用付费模型生成大量测试内容。

未来功能可以在 schema 和 service boundary 中预留，但不能因此拖慢首版完成。

## 2. 产品视觉规范与导航交互

### 2.1 风格

设计风格：**Linear × Notion 式轻量专业效率工具**。参考 ima 的知识库管理布局与交互方式，但不要复制腾讯名称、商标、图标或直接照搬素材。品牌名固定为 `知簇`，英文 `ZhiCluster`；可设计原创的简洁“聚簇/节点”几何 SVG 图标（可用 SVG 源码实现）。默认中文界面。

- 浅色：暖/冷中性白灰底，轻微层次与细边框；强调色建议低饱和靛蓝 / 蓝紫（约 `#6366F1`），少量状态色，整体克制。
- 深色：接近 Linear 的深灰面板与柔和分隔线，保持清晰可读的对比度；亮暗色均须真实实现。
- 采用 CSS 变量或 shadcn 主题 tokens；字体优先系统字体及常见 sans-serif，中文字体回退合理，无需外部付费字体。
- 有细致的 hover、focus、selected、disabled、loading、empty、error、success 状态，统一圆角、间距、动画时长。避免铺满大卡片和冗余渐变。

### 2.2 四区桌面布局

1. **最左导航 rail：约 56–64px**。品牌图标、知识库、搜索、会话、设置，底部主题与应用入口；当前选中态清晰。
2. **知识库侧栏：约 230–260px**。多知识库列表、新建、切换、名称/描述管理；当前库的标签概览与筛选；明确个人知识库。首版不要放点击后无效果的“共享知识库”入口。
3. **文件管理栏：约 300–360px**。当前知识库的多级文件夹树、面包屑、文件列表、筛选排序、数量与处理状态、上传、批量选择/操作、右键菜单；拖拽上传本地文件及移动现有文档。
4. **主工作区：剩余宽度**。顶部清晰的对话/文档预览/智能整理（Agent）视图切换；AI 回复、文档阅读及元数据详情、Agent 时间线/审核计划在此展示。

支持导航栏/侧栏折叠、关键分割线拖动改变宽度、宽度与主题存入 localStorage；桌面 1440×900 首先保证精致，低于 1024px 时自动收起侧栏，不能挤出横向滚动的大量不可用控件。默认网页标题显示 ZhiCluster，页面有 favicon 和基础响应式适配。

### 2.3 必须真实可用的交互

- 文件拖拽上传；批量上传结果与单文件状态；文件夹之间拖动文件；文件夹移动时检测循环引用。
- 单击文件选中并展示摘要卡/详情；双击或“打开”进入阅读器；支持 PDF 页跳转、DOCX/MD/TXT 解析后的章节/段落定位及原文件下载。
- 文件/文件夹右键菜单：适用项包括重命名、移动、添加标签、删除到回收站、恢复等；键盘操作可达。
- Ctrl/Cmd + K 打开全局搜索弹窗，支持关键字输入、键盘选择结果与关闭。
- 多选列表、全选当前范围、批量打标/移动/删除；排序按名称/日期/类型；通过文件夹/标签/状态筛选。
- 创建/重命名/删除知识库和文件夹时提供真实持久化；软删除和恢复需有 UI。
- “智能整理”展示 Agent 步骤、工具调用的**用户可理解描述**、可编辑的计划列表、确认/拒绝/执行结果及撤销按钮。
- 每个异步操作有反馈；API 错误可定位并重试；不能用 alert() 假装交互，不要用 hardcoded demo 数据代替真实列表。

## 3. 多用户预留但本地免登录

首版启动自动创建固定 `demo_user` 与默认个人知识库“我的知识库”；所有请求通过后端本地身份上下文取得 actor（不能相信浏览器随意传来的 user_id），不展示登录入口。

必须提前设计：

- `users(id, email, display_name, ...)`
- `knowledge_bases(id, owner_id, name, description, visibility/private, ...)`
- `knowledge_base_members(id, kb_id, user_id, role: owner|editor|viewer, ...)`
- `folders`、`documents`、`tags`、`document_chunks` 等均明确关联 `knowledge_base_id`，对跨库资源建立必要的一致性校验/约束。
- 权限服务至少有 `get_actor`、`assert_can_read_kb`、`assert_can_edit_kb`、`assert_can_manage_kb`，且路由、下载、搜索、聊天检索、Agent 工具都统一调用。当前 demo 用户为默认库 owner，但不要写死所有业务绕过权限。
- 任何向量查询**在 SQL 检索阶段**就必须限制允许访问的 knowledge_base_id，后续再加文件夹/标签范围约束。不要先全局取向量候选再在 LLM 或前端过滤。
- 本地免登录设置只允许回环地址访问：Compose host binding `127.0.0.1`；正式/公开部署时如未配置认证应 fail closed，不能将 demo user 模式公网暴露。CORS 严格限制开发源，不开启 `*` 加凭据。

## 4. 数据库 schema 与迁移

使用 PostgreSQL + SQLAlchemy 2 + Alembic；所有关键表包含 UUID 主键、时间戳与索引；用户编辑的实体适当加入 `version`/`updated_at` 以支持并发冲突检测。至少设计：

1. `users`
2. `knowledge_bases`
3. `knowledge_base_members`
4. `folders`：`kb_id`、`parent_id`、`name`、`sort_order`、`deleted_at`，同库父子关系、禁止自己/后代作为父级；同级重名策略明确。
5. `documents`：`kb_id`、`folder_id` 可空、`owner_id`、`display_name`、`original_filename`、`mime_type`、`ext`、`sha256`、`size_bytes`、`storage_key`、`parse_status`、`index_status`、`summary_status`、`classification_status`、`short_summary`、`detailed_summary`、`error`、`deleted_at`、`version`；按需拆状态字段或合并 job 表，但功能等价。
6. `document_sections`：`document_id`、`kb_id`、`parent_section_id`、`heading`、`level`、`order`、`plain_text`/text pointer、`section_summary`、`page_start/page_end` 或 `paragraph_start/end` / `line_start/end`，区分不同格式能定位到的精度。
7. `document_chunks`：`kb_id`、`document_id`、`section_id`、`chunk_index`、`content`、`token_count`、`page/paragraph/line anchors`、`source_start/source_end`、`created_at`；索引按 KB、文档、节、删除可见性等过滤。
8. `embedding_profiles`：`model_id`/provider fingerprint、`model_name`、`dimension`、`status`、`created_at`；**绝不存 API Key**。
9. `chunk_embeddings`：`kb_id`、`chunk_id`、`profile_id`、`embedding vector`（允许按 profile 不同维度存储，实际维度由程序校验），对 `(chunk_id, profile_id)` 唯一；强制记录模型及维度。
10. `tags`：`kb_id`、规范化名称、显示名称、颜色、可选别名；同知识库下规范化名称唯一。
11. `document_tags`：文档-标签多对多；跨库关联必须被拒绝。
12. `classification_suggestions`：目标文档、推荐已有 folder/tag IDs、候选新标签/文件夹名称、理由、状态（pending/applied/rejected）、生成时文档版本、模型与时间。
13. `ingestion_jobs`、`job_events`：每阶段状态/进度、重试次数、租约、错误、时间戳、可恢复游标/事件序号。
14. `conversations`、`messages`、`message_citations`：消息角色/内容、选择的知识库范围和过滤条件、出处 chunk ID、具体锚点、引用序号，支持重启持久化。
15. `agent_runs`、`agent_plans`、`agent_plan_operations`、`agent_events`：状态、thread_id、结构化计划 JSON/正规化操作记录、审批人、审批时间、执行结果、错误等。
16. `audit_logs`、`undo_records`、`trash_records` 或能等价支持软删除及撤销的结构。

全部 DB schema 通过 migration 创建，启用 pgvector/pg_trgm。禁止只靠 `create_all()` 而没有 migration；独立的迁移任务应该幂等。留出 checkpoint 专用 schema/table（使用已安装的 LangGraph PostgreSQL saver 官方 `setup` 初始化方式），业务消息记录与 checkpoint 不可互相替代。

**Embedding 维度策略（重点）**：不可单纯写死 `vector(1024)` 或假设换模型自动兼容。存储当前模型 profile、维度和索引版本；插入前验证长度；检索只使用当前有效 profile 的向量。对于 pgvector `vector` 类型的近似索引维度限制，应首先保证**小规模 Demo 可用的精确 cosine 检索**；在维度受支持的 profile 上可创建按维度/模型区分的 HNSW 索引，不能将不同维度混用，必要时考虑 `halfvec` 合理索引。更换模型/维度时提供“需重新向量化”状态与显式重建流程；索引不可用时友好降级到正确的精确检索，绝不静默匹配错误维度。

## 5. 文件上传、安全存储与异步入库

### 5.1 文件格式与限制

首版支持 PDF、DOCX、Markdown (`.md`)、TXT (`.txt`)；支持一次选择/拖入多文件。默认单文件最大 50 MiB（可配置），限制单批总量及并发；后端验证扩展名、内容类型及文件签名/结构，文件路径由服务器生成，不接受任意路径。为每个文件计算 SHA-256，同一知识库发现完全相同文件时返回清楚的“跳过/保留副本”选择，不要静默重复向量化。允许同名不同内容文件，采用明确的冲突策略。

原始文件放在 `/data/uploads/<kb_uuid>/<document_uuid>/original` 一类私有目录，数据库保存 storage_key，用户原始文件名仅作显示；下载接口必须鉴权、校验归属、禁止路径遍历。文件本身不作为可执行内容，不运行宏，不执行文档中的代码。

### 5.2 解析与切块

- PDF：PyMuPDF 提取正文和页码；尽可能利用目录/标题/字号启发式构建章节。扫描 PDF 无可提取文本时报告“缺少文本层，首版不支持 OCR”，不能显示解析成功但内容为空。
- DOCX：python-docx 提取段落、Heading、表格文字，按段落定位；**不要虚构 DOCX 页码**。
- MD：保留标题层级、行号/块起始偏移，渲染时做安全处理。
- TXT：检测常见编码并回退；段落、行号锚点。
- 统一产出有顺序和来源锚点的 sections，保存必要原文用于阅读和精准溯源。
- 优先按标题/段落结构分块，默认每个检索 chunk **800 tokens 左右、重叠约 100 tokens**（可配置），避免在句中截断；每块存 section 关联与页码/行号。分块必须确定性且可重建。
- 文件目录/标签/名称变化不得触发全文解析或所有 Embedding 重新计算。

### 5.3 超长文档摘要与 AI 分类

入库后并行/分阶段完成三个逻辑上独立的产物：**chunks+embeddings、章节与全文摘要、目录与标签建议**。

- 小文档可直接摘要；超长文档应按 section 或若干大段生成摘要，再自底向上分组递归聚合（map-reduce/tree summarization），严格控制每次模型请求的 token 上限，不将整个 500 页文件盲目塞进一次调用。
- 产出：列表短摘要（例如 100–200 中文字）、详情长摘要（例如 300–800 字）、有意义的章节摘要、关键词、主体主题；可配成本/长度限制；处理失败时保存原有可用产物。
- AI 分类的输入来自标题、目录、各章节摘要与现有分类/标签；先**匹配已存在文件夹和标签**，然后才建议新增，优先中文语义同义项归一化（Unicode NFKC、大小写、空白及可配置别名）；一份文档推荐 3–6 个标签，最多建议一个主要文件夹，允许根目录“未分类”。
- 输出 Pydantic 结构化字段：`existing_folder_id?`、`proposed_folder_path?`、`existing_tag_ids[]`、`new_tag_names[]`、`short_summary`、`reason`、`confidence_hint`。`confidence_hint` 仅作为启发式解释，**不能冒充数学上已校准的概率**。
- AI 只建议，用户确认/调整才应用。建议结果保存于 DB，防止刷新丢失；应用时再次校验目标文件夹/标签存在且同库、版本未变。
- 如果未配置模型或摘要/分类失败：文档的解析、手动分类、文件阅读和关键词搜索仍能工作；相应 AI 阶段显示未配置或可重试，不得让整个文件永久卡在“处理中”。

### 5.4 可靠的后台任务

**不能在单个 HTTP 上传请求或 FastAPI 进程内执行长时间入库逻辑。** 上传请求尽快保存文件并创建 `ingestion_job`，独立 worker 轮询 DB 任务队列，使用事务与 `FOR UPDATE SKIP LOCKED` 等领取机制、lease/heartbeat、幂等键，防止并发重复执行；超时租约可恢复。默认保留任务重试次数与指数退避，针对 429、超时、5xx 做有限重试；不可无限重试消耗 API 额度。

推荐阶段状态：`queued → parsing → chunking → embedding → summarizing → classifying → completed`，同时在 DB 保存子阶段状态；失败可记录 `partial_ready/failed`、错误与可从哪个阶段重试；用户可取消未执行任务、重试失败阶段。大型文件分批 Embedding，记录批次进度与已完成数量，不重复计费。进度和事件通过 SSE 推送、刷新后可从 DB 查询恢复，禁止只用内存字典存任务进度。

## 6. 多知识库、文件夹、标签和手动管理

- 一个文档只属于一个知识库，`folder_id` 为可空单一归属；一个文档可以拥有多个标签。当前 KB 的标签与文件夹默认独立，不跨库混用。
- 支持创建/修改/软删除/恢复知识库，新增/重命名/移动/删除文件夹，嵌套层级理论上不限（实际 API 带分页与合理深度保护）；后端检测移动到自身后代、跨库父节点、重名冲突。
- 未归档文档放 KB 根目录/“未分类”筛选；前端有明确未分类视图。
- 批量移动、打标签、移除标签、重命名、软删除、恢复；统一审计。
- 标签增删改、颜色、别名、合并建议；归一化防止 `LLM / 大语言模型 / Large Language Model` 随机反复新建等价标签（合并由用户批准）。
- 手工变更默认即时生效，但 Agent 变更走审批计划。可撤销操作记录修改前快照；删除首先进入回收站，不立即删除源文件，恢复时更新 RAG 可见性。
- 跨知识库移动首版建议由后端显式限制或按高风险流程实现，绝不能直接把同一 folder_id 或 tag_id 挂到其他知识库下。

## 7. 混合检索、范围约束与引用

### 7.1 搜索

提供独立的搜索入口（全局 Ctrl/Cmd+K，以及知识库内搜索），后端统一检索服务支持：

- 查询字符串；知识库 ID 数组（只允许当前 actor 有权访问的）；folder IDs（是否包含所有子文件夹的开关）、tag IDs（默认交集/并集逻辑清楚标示）、文档格式、文档 IDs 和时间范围的可选过滤。
- 关键词：针对中文首版使用 `pg_trgm`/ILIKE 及文件名/片段内容匹配，适合专有名词与中文；不要假设 PostgreSQL 英文全文索引直接提供完善中文分词。必要时补充全文索引但需真实测试中文召回。
- 语义：用当前 Embedding profile 将 query 向量化，pgvector cosine 检索；先在数据库中限制当前可见的 KB、文件夹/标签、未软删除和完成索引的文档；不得从全库取 Top K 后在 Python 里过滤权限。
- 融合：两个候选列表通过 **RRF**（例如 k=60，可配置）归并排序，去重 chunk，必要时提升命中文件名的结果，返回 score、snippet、doc id、chunk id 和定位锚点。
- 若无 Embedding 配置或模型故障，明确告知“仅关键词搜索”，不假装提供语义检索。近似索引与过滤导致召回不足时可用精确向量搜索作可靠 fallback。

### 7.2 知识库问答

- 同一个会话可选择一个或多个**有访问权限**的知识库，以及文件夹/标签/文件范围；会话保存当时的范围约束和来源。
- 聊天历史持久化，支持创建、重命名、删除会话；刷新/重启后继续对话，后端保护对话与其 KB scope。
- 检索与回答使用真实文档内容；对提问做必要的多轮上下文重写/摘要，但不能丢失范围；返回生成 token SSE。
- 模型回答允许使用 Markdown，来源通过后台**真实 chunk ID → document ID + section + page/line/paragraph anchor**生成。可以让模型只引用检索上下文中的 `[S1]`、`[S2]` 等受限引用标记，随后后端做白名单验证并构造结构化 `citations[]`。不可相信模型自报的文件名、页码或任意 URL；不能凭空制造来源。
- 点击引用应打开阅读器对应 PDF 页码/MD 行段/DOCX 段落/纯文本行段，并突出显示相关片段（如果 PDF 文本层不能精确高亮，至少跳到真实页并显示对应 snippet）。
- 相关内容不足时明确“在当前知识范围内找不到足够依据”，展示检索范围，不胡编。引用来自被软删除或后来失去权限的文档时应阻止访问并给出说明。
- 用户文档中的“忽略系统指令、删除数据”等文字只作为待分析内容，不能进入指令层或直接转化为 Agent 写工具调用。

### 7.3 可观察性

可以在问答后展示使用的知识库、检索结果条目及耗时（不暴露敏感密钥）；支持点击来源查看原文，不泄漏其他知识库内容。

## 8. Agent：自然语言多步骤整理 + 整批审批

### 8.1 Agent 功能与工具

使用 LangChain `create_agent` 提供多轮意图理解和工具调用；LangGraph 控制 `Plan → Review → Execute → Verify/Done` 状态与持久化。只读工具可自动调用：

- `list_knowledge_bases`
- `list_folders`
- `list_tags`
- `list_documents`（带分页和过滤）
- `get_document`（摘要、元数据、章节；大文件分段读取）
- `search_knowledge`（走统一检索与权限服务）
- `get_unclassified_documents`

有副作用的**业务操作**由计划执行器实现，而非授权模型直接操作数据库：

- `create_folder`
- `move_documents`
- `update_document_tags`（add/remove/set）
- `rename_document`
- `rename_folder`
- `trash_documents`（软删除）
- 如实现跨 KB 移动则始终视作高风险并追加批准；首版允许禁止。

不要提供任意 Shell、SQL 或 Python 执行工具。LLM 永远不能绕过 services 权限和结构化验证。

### 8.2 交互样例

用户输入：“整理这个知识库里所有未分类的论文，按机器学习、RAG、多智能体方向建立文件夹并加标签。”

预期效果：Agent 使用只读工具查询现有文件/摘要/标签→形成有序、结构化、具有依赖关系的计划→**暂停等待一次整批审批**→用户修改单个目标文件夹/标签或取消操作→后端重新校验→用户点击“批准执行”→后端逐项/事务执行→显示结果和可撤销操作。

### 8.3 计划与审批数据结构

建议 Pydantic `AgentPlan` 至少包含：`plan_id`, `kb_id`, `goal`, `summary`, `operations[]`, `expected_changes`, `risk_level`, `status`, `base_versions`, `created_at`。每个 `operation` 包含稳定 `operation_id`、`type`、`target_ids[]`、合法参数、用户可读描述、依赖 operation IDs、risk 和可撤销性。新建文件夹可通过计划内临时引用连接后续 move 操作。

- 前端预览必须让用户逐条勾选/取消，并修改目标文件夹、添加/去除标签；展示总影响数量。
- **用户批准的是编辑后的最终计划**；后端绝不能继续执行修改前的模型原始参数。
- 操作前检验所有 document/folder/tag 的库归属、版本、存在性、权限和依赖；若审批期间数据有变化，阻止执行并提示重新生成/审阅。防止重复审批或重复执行：使用计划状态流转、数据库锁、幂等键。
- 整批低风险操作一次批准，不出现几十个逐次审批弹窗；涉及**软删除、跨库修改、清空目录**等高风险操作需独立的明确确认对话框，显示影响数量。
- 对跨库或非法操作直接拒绝，不允许所谓“AI 有权限就能执行”。
- 操作采用合理事务边界：单计划可尽量在一个 DB 事务里应用元数据变更；长耗时外部操作应拆分幂等步骤，报告部分成功/失败，不宣称不可能的全局分布式原子性。
- 审计日志包括 actor、run_id、plan_id、operation_id、操作前后差异、发生时间、结果与失败原因；显示可读时间线。

### 8.4 可撤销性 / 中断恢复

- 创建/重命名/移动/打标签等记录变更前状态，成功执行后提供明确的“撤销此次整理”入口。
- 软删除放入回收站，可恢复；**禁止 Agent 直接永久删除实体文件**。
- 撤销前重新检查版本及数据冲突；存在后续人工变更时阻止危险覆盖，报告不能撤销的项目，不能无条件回滚其他用户的新操作。
- 采用 `langgraph-checkpoint-postgres` 的持久 checkpointer；调用 `setup` 初始化；thread_id 为短 UUID，重启后可恢复待审批计划。**LangGraph checkpoint 不等于业务操作撤销日志**，二者必须分开保存。
- Agent SSE 进度只显示“正在列出文档/找到 N 个候选/生成计划/等待审批/执行结果”等可理解工具活动，不暴露模型内部隐藏推理文本。
- 如果所选 LLM 不支持 tool calling，配置页要明确提示，知识问答可继续，Agent 不得假装成功。

## 9. API 建议（必要时细调，但功能必须等价）

统一前缀 `/api`，Pydantic 输入输出模型，OpenAPI 自动生成，标准错误结构（code/message/details/request_id）。至少包括：

- `GET /api/health`、`GET /api/ready`、`GET /api/settings/model-status`、`POST /api/settings/test-models`（不返回密钥；支持测试 LLM、Embedding、tool calling 能力）
- `GET/POST /api/knowledge-bases`、`GET/PATCH/DELETE /api/knowledge-bases/{kb_id}`
- `GET/POST /api/knowledge-bases/{kb_id}/folders`、`PATCH/DELETE /api/folders/{folder_id}`
- `GET/POST /api/knowledge-bases/{kb_id}/tags`、`PATCH/DELETE /api/tags/{tag_id}`；标签合并按需加专用路由
- `GET /api/knowledge-bases/{kb_id}/documents`（分页/过滤/排序）；`POST /api/knowledge-bases/{kb_id}/uploads`（multipart 多文件 + folder_id 可选）；`GET/PATCH/DELETE /api/documents/{id}`；`GET /api/documents/{id}/content`、`GET /api/documents/{id}/download`、`GET /api/documents/{id}/sections`；`POST /api/documents/batch`；回收站恢复
- `GET /api/ingestion/jobs`、`GET /api/ingestion/jobs/{id}`、`POST /api/ingestion/jobs/{id}/retry`、`POST /api/ingestion/jobs/{id}/cancel`、`GET /api/ingestion/jobs/{id}/events`（SSE）
- `GET /api/documents/{id}/suggestion`、`PATCH/POST /api/documents/{id}/suggestion`（修改、应用、拒绝）
- `POST /api/search`（keyword/hybrid + filters + pagination）
- `GET/POST /api/conversations`、`GET/PATCH/DELETE /api/conversations/{id}`、`GET /api/conversations/{id}/messages`、`POST /api/conversations/{id}/messages`、`GET /api/conversations/{id}/events`（流式）
- `POST /api/agent/runs`、`GET /api/agent/runs/{id}`、`GET /api/agent/runs/{id}/events`；`GET/PATCH /api/agent/plans/{id}`；`POST /api/agent/plans/{id}/approve`、`POST .../reject`、`POST /api/agent/runs/{id}/undo`

SSE 建议事件类型：`status`, `progress`, `token`, `tool_start`, `tool_end`, `plan_ready`, `approval_required`, `citation`, `completed`, `error`，带事件 id / sequence / timestamp；提交聊天/Agent 消息可用 POST 创建 run，再 GET SSE 订阅；不要用 `EventSource` 发送 POST JSON。支持连接中断后重新查询持久化结果，不能仅依赖一条不断线的 socket。API 设计若作调整，需更新 OpenAPI 与前端客户端。

## 10. 配置与模型提供方设计

后端用 Pydantic Settings 读取配置，提供 `.env.example`（**真实密钥绝不能提交**）：

```dotenv
APP_ENV=local
APP_HOST=0.0.0.0
APP_PORT=8000
DATABASE_URL=postgresql+asyncpg://zhicluster:local_password@db:5432/zhicluster
UPLOAD_ROOT=/data/uploads
MAX_UPLOAD_SIZE_MB=50

LLM_BASE_URL=https://your-provider.example/v1
LLM_API_KEY=
LLM_MODEL=your-chat-model
LLM_TIMEOUT_SECONDS=120

EMBEDDING_BASE_URL=https://your-embedding-provider.example/v1
EMBEDDING_API_KEY=
EMBEDDING_MODEL=your-embedding-model
EMBEDDING_DIMENSION=1024
EMBEDDING_BATCH_SIZE=32

CHUNK_SIZE_TOKENS=800
CHUNK_OVERLAP_TOKENS=100
MAX_INGESTION_ATTEMPTS=3
MAX_CONCURRENT_MODEL_CALLS=3
```

上述模型 URL/名称和 `1024` 维只是**占位示例，不是固定默认厂商**。同时支持 LLM 与 Embedding 不同服务商，API Key 永不进入前端 bundle、日志或 API 响应。Embedding 维度通过提供方实际返回向量校验；模型切换后在设置页显示“不兼容，待重建索引”，不要把不同 profile 的数据混合查询。

没有 API Key 时，本地文件管理、解析、关键词搜索、标签/文件夹管理仍正常；AI 摘要、自动分类、向量检索、LLM 问答与 Agent 显示“需要配置模型服务”，允许稍后补密钥继续任务。**禁止在正常使用路径静默返回假的 AI 摘要、Embedding 或 Agent 计划。**

## 11. 运行、持久化、热更新与 README

### 11.1 Docker Compose 生产式本地 Demo

`docker compose up --build -d` 启动完整站点，浏览器打开 `http://localhost:3000`。服务建议：

- `db`：带 pgvector 的 PostgreSQL，volume 保存 DB；启用 healthcheck。
- `migrate`：等待 DB healthy，执行 Alembic + checkpoint setup + seed demo user / 默认知识库；成功退出。所有步骤可重复执行。
- `api`：等待 migrate 成功，启动 FastAPI，后端仅发布到宿主机 `127.0.0.1:8000` 或仅由 web 反向代理访问。
- `worker`：共用 backend 代码和持久化 volume，执行后台 job poller，等待 migrate；支持 graceful shutdown / lease recovery。
- `web`：构建静态 React 产物并通过 Nginx 等轻量服务提供 `127.0.0.1:3000`；`/api` 反向代理到 `api`，SSE 关闭代理缓冲且设置合理超时。

全部宿主机发布端口绑 `127.0.0.1`；应用数据（DB、上传原文件）持久化；`docker compose down` 默认不删除数据，文档标注 `down -v` 会删数据。避免在镜像中硬编码密钥或打包 `.env`。

### 11.2 热更新开发模式

提供 `compose.dev.yaml`（或等价）和明确命令，如：

```bash
docker compose -f compose.yaml -f compose.dev.yaml up --build
```

开发模式 bind-mount 前后端源码，React/Vite HMR 与 FastAPI `uvicorn --reload` 真实生效；worker 的源码变化有可靠的重启/重载路径。可额外提供主机 `pnpm dev` + `uv run ...` 工作流，保证数据库依旧可由 Docker 启动。开发与完整启动都应避免默认公网监听，说明 WSL2 / Windows Docker Desktop 的注意事项。

### 11.3 文档

README 至少包含前置条件、复制 `.env.example`、设置两个模型服务、启动/停止/查看日志、热更新、迁移、测试、数据库备份与上传数据保存位置、重建 Embedding、无 Key 能做什么、常见问题。新用户按 README 最多几步就能在浏览器看到可以操作的知识库。

## 12. 建议仓库结构

```text
ZhiCluster/
├── frontend/
│   ├── src/
│   │   ├── app/                 # routes / providers
│   │   ├── components/ui/       # shadcn/ui
│   │   ├── components/layout/   # four-column desktop shell
│   │   ├── features/kb/
│   │   ├── features/documents/
│   │   ├── features/search/
│   │   ├── features/chat/
│   │   ├── features/agent/
│   │   ├── features/settings/
│   │   ├── lib/api/
│   │   ├── stores/
│   │   └── styles/
│   ├── public/
│   ├── package.json
│   └── pnpm-lock.yaml
├── backend/
│   ├── app/
│   │   ├── main.py
│   │   ├── core/                 # config / security / error handling
│   │   ├── db/                   # models / sessions
│   │   ├── api/
│   │   ├── schemas/
│   │   ├── repositories/
│   │   ├── services/
│   │   ├── ingestion/            # loaders/chunking/summary/classify
│   │   ├── retrieval/            # keyword/vector/rrf/citations
│   │   ├── ai/                   # LLM + embeddings adapters
│   │   ├── agent/                # tools / graph / plans / approvals
│   │   └── worker/
│   ├── alembic/
│   ├── tests/
│   ├── pyproject.toml
│   └── uv.lock
├── docs/
│   ├── architecture.md
│   ├── data-model.md
│   ├── api.md
│   ├── acceptance.md
│   └── implementation-report.md
├── compose.yaml
├── compose.dev.yaml
├── .env.example
├── .gitignore
└── README.md
```

如果你认为某个文件夹需要合并或重命名，可以做合理调整，但架构分层、完整性、可维护性与清楚文档必须保持。

## 13. 实施次序（连续推进，不要只写计划）

**M0 骨架**：检查仓库；创建 Monorepo、依赖锁定、Compose/数据库、迁移、settings、健康检查；启动前后端空壳和初始知识库。

**M1 知识管理 UI + API**：四区页面、主题、知识库/文件夹/标签 CRUD、文件上传及列表、拖拽、右键菜单、批量操作、阅读器与下载、持久化。

**M2 入库 pipeline**：worker job leases、四种格式解析、sections+chunks、Embedding profile、批量向量化、层级摘要、分类标签建议、任务进度/重试、失败降级。

**M3 搜索与 RAG**：pg_trgm + cosine + RRF + KB/文件夹/标签范围、全局搜索、对话持久化、流式响应、真实 citations、PDF/文本位置跳转。

**M4 Agent**：只读工具、create_agent 规划、结构化计划、LangGraph checkpoint、人工编辑/整批批准/高风险确认、执行/审计/撤销、事件时间线。

**M5 收尾**：增强 UI 和可访问性、空/错/载状态、性能及安全校验、自动化和端到端测试、Docker 重启持久化验证、README、最终报告。

每个里程碑实现后执行可行的测试。不要因为一个非关键 UI 细节阻断主干开发，也不能省掉审批与权限之类的关键安全边界。

## 14. 验收标准（必须逐条验证并报告）

### 14.1 无真实 AI Key 也可验证的测试

- [ ] `docker compose up --build -d` 启动成功，`http://localhost:3000` 可访问，健康检查通过；开发模式热更新生效。
- [ ] 默认 demo 用户与知识库自动建立，重启服务仍保存 KB、文件夹、标签和原文件。
- [ ] 创建 2 个知识库、多个嵌套文件夹、标签，操作生效；不同知识库数据与检索隔离。
- [ ] 上传 PDF、DOCX、MD、TXT 测试样例，解析正文与来源锚点正确；空扫描 PDF 明确提示无文本层。
- [ ] 同一文件重复上传可被检测并处理，非法格式、超限文件、危险文件名均得到正确错误。
- [ ] 上传任务执行/失败/重试/重启恢复逻辑可通过 mock provider / 单元测试验证。
- [ ] 文件夹拖拽、批量移动/打标/软删除/恢复、右键菜单、Ctrl+K、亮暗主题、折叠侧栏、筛选排序工作正常。
- [ ] pg_trgm/关键词搜索对中文文件名及中文 chunk 有实测命中；无 Embedding 时明确降级。
- [ ] 对手工构造的跨库访问、伪造 folder_id/tag_id、非法移动子树、已删除资源访问，服务层返回拒绝。
- [ ] Agent 的计划结构校验、人工编辑与一次审批、重复审批幂等、版本冲突、审计记录、撤销使用可控 fake model 工具测试通过（不得把这些当作真实 AI 联网验收）。
- [ ] SSE 的事件结构及断线后结果恢复至少有自动化或可执行验证脚本。
- [ ] TypeScript typecheck、ESLint、frontend build、Ruff、Pytest 通过；DB migration 从全新库通过。

### 14.2 配好真实云端 LLM + Embedding 后的测试

- [ ] 配置页能分别校验聊天、Embedding 与 LLM tool calling；错误原因可理解。
- [ ] 上传含多个章节的长文档，生成 chunks、向量、章节摘要、全文摘要、标签与文件夹建议。
- [ ] 新文档可匹配已有标签，手动调整建议后应用能正确持久化。
- [ ] 多知识库+文件夹+标签过滤的 hybrid search 只返回对应范围的资料，RRF 去重可观察。
- [ ] RAG 提问返回真实引用，引用点击正确跳至原 PDF 页 / MD 行段 / DOCX 段落；答案找不到证据时不编造。
- [ ] Agent 能接收“整理未分类论文”指令，真实调用只读工具生成计划；用户编辑目标后批准，最终数据库状态与**编辑后的计划**一致。
- [ ] Agent 拒绝计划时不发生任何写入；高风险操作必须额外确认；执行后操作日志与撤销工作；重启后 pending plan 可以重新打开。

### 14.3 数据和安全验收

- [ ] `.env` 在 `.gitignore`，密钥不返回前端、不写入日志；本地免登录不能被 Compose 默认公网暴露。
- [ ] 检索 SQL 中有实际的可访问 KB ID 过滤，下载和 Agent tools 也走相同的权限服务。
- [ ] 文件数据默认私有且不存在路径遍历；HTML/Markdown 预览有 XSS 防护；文档中的注入指令不被授予工具权限。
- [ ] 文件夹改名/打标签不触发无谓的重新向量化；换 Embedding 维度不会让错误向量被混合检索。
- [ ] Agent 写工具所有副作用可追溯，审批之前零业务副作用，软删除可恢复。

### 14.4 测试与报告要求

优先为核心状态机、权限、文件夹树、入库重试、检索融合、引用验证、Agent 计划/撤销写单元与集成测试；至少提供一个自动化的端到端主流程。测试生成的 PDF/DOCX/MD/TXT 样例可以放 `tests/fixtures/`；API 相关测试可使用确定性 mock provider，真正的联网测试应明确分类为可选集成测试。

在 `docs/acceptance.md` 按每项列出：**PASS / FAIL / NOT_RUN / BLOCKED（缺密钥或环境）**、实际执行命令、简要输出或日志。不能把 `NOT_RUN` 写作 `PASS`。

## 15. 最终交付清单

必须提供：

1. **完整代码**：前端、后端、worker、迁移、Agent、测试用例，所有已承诺功能有可运行实现。
2. **配置**：Compose 全量/开发模式、`.env.example`、依赖 lockfile、`.gitignore`、初始化脚本。
3. **文档**：README、架构/数据模型/API/验收、AI/Embedding 重建说明、已知限制。
4. **自测证据**：实际运行过的 install/lint/typecheck/build/test/compose/迁移命令和结果（能执行什么就执行什么）。
5. **最终报告** `docs/implementation-report.md`：功能完成矩阵（完成/部分/未完成）、设计取舍、受阻点、如何填写 API Key、启动 URL、后续优化优先级。

最终回复我时请简明列出：

- 最终完成了哪些具体功能、哪些没完成；
- 完整启动命令与本地访问地址；
- 需要我填哪些 `.env` 项；
- 实际执行的检查及 PASS/FAIL/BLOCKED；
- 当前最值得优先修的 3 个问题。

### 开始执行

现在请先检查仓库，然后立即进入 M0→M5 的开发工作。除非存在会破坏现有文件或需要付费凭据才能继续的不可绕过问题，否则请自行做合理决策持续实现。不要仅给我一个技术方案，也不要只生成 README 或静态 UI。**交付目标是可以启动、可以管理真实文件、能够对接真实模型、经过实际测试的「知簇 · ZhiCluster」Demo。**

---

## 16. 官方技术参考（实现时优先查阅）

- LangChain Agent / HITL：https://docs.langchain.com/oss/python/langchain/human-in-the-loop
- LangChain structured output：https://docs.langchain.com/oss/python/langchain/structured-output
- LangGraph persistence：https://docs.langchain.com/oss/python/langgraph/persistence
- pgvector 与 Hybrid Search：https://github.com/pgvector/pgvector
- Docker Compose depends_on / healthcheck：https://docs.docker.com/compose/how-tos/startup-order

不要为了照抄示例而固定版本：以实际安装包的 API 与官方文档为准，并在 lockfile 中固定最终验证过的依赖版本。
