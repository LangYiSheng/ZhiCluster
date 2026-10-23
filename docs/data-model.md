# 数据模型

业务 schema 共 26 张表，见 `backend/app/db/models.py`。资源主键使用 UUID 字符串；除关联表 `document_tags` 和单例配置表 `app_configurations` 外，业务实体统一包含 `id`、`created_at`、`updated_at`。数据库由 Alembic 迁移创建，初始化任务可重复执行；运行期不依赖 `create_all()`。

## 表与职责

| 表 | 主要字段与约束 | 职责 |
| --- | --- | --- |
| app_configurations | id=`runtime` 单例主键、revision、values JSON、secrets JSON、updated_at | 当前有效运行配置；提供方密钥只保存 Fernet 密文 |
| storage_deletions | owner_id 索引、storage_key unique、attempts、error | 已确认永久删除后的原文件清理记录，不依赖已删除文档或 KB 外键 |
| users | email unique、display_name | 固定本地 demo actor，预留未来真实用户 |
| knowledge_bases | owner_id、name、description、visibility、version、deleted_at | 知识库与软删除 |
| knowledge_base_members | kb_id/user_id unique、role check | owner/editor/viewer 权限角色 |
| folders | kb_id、parent_id、name、sort_order、version、deleted_at | 多级目录；父目录同库，不可自指 |
| documents | kb_id、folder_id、owner_id、名称/格式/hash/大小/storage_key、四子阶段状态、摘要、summary_metadata、version、deleted_at | 文档元数据、处理状态、关键词/主体主题、回收站；storage_key unique |
| document_sections | kb_id/document_id、parent_section_id、heading、level、order、plain_text、section_summary、anchors JSON | 有序原文与标题层级、来源位置 |
| document_chunks | kb_id/document_id/section_id、chunk_index、content、token_count、anchors、source_start/end | 检索单元；document_id/chunk_index unique |
| embedding_profiles | fingerprint unique、model_name、dimension、status | 模型服务/名称/维度识别；不保存密钥 |
| chunk_embeddings | kb_id/chunk_id/profile_id、embedding | chunk_id/profile_id unique；无固定维度 vector |
| tags | kb_id、name、normalized_name、color、aliases JSON、version | kb_id/normalized_name unique；NFKC/大小写/空白归一化 |
| document_tags | document_id/tag_id 联合主键、kb_id | 文档和标签多对多，同库关联 |
| classification_suggestions | document_id unique、kb_id、payload JSON、status、document_version、model | 持久化 AI 建议，不自动应用 |
| ingestion_jobs | document_id nullable、kb_id、kind、status/stage/progress、attempts、lease_owner/until、next_attempt_at、error、payload | DB 持久队列，kind 包括 ingest/reindex/chat/agent |
| job_events | job_id、sequence、type、data JSON | 任务进度和错误事件，可回放 |
| conversations | user_id、title、scope JSON、deleted_at | 多知识库/目录/标签范围及会话生命周期 |
| messages | conversation_id、role、content、status、error、retrieval JSON | 持久化多轮问答、检索观测、执行阶段及流式事件水位 |
| message_citations | message_id、chunk_id、document_id、ordinal、anchors、snippet | 真实 chunk 白名单引用 |
| conversation_events | conversation_id、sequence、type、data | progress、带偏移的 token、候选/最终 citation、completed/error 等 SSE 回放 |
| agent_runs | kb_id、actor_id、thread_id unique、goal、status、error | 工作流实例与短 UUID thread |
| agent_plans | run_id unique、kb_id、payload、status、version、approved_by/at、result | 用户审阅后的最终计划及审批 |
| agent_plan_operations | plan_id、operation_id、payload、status | 规范化逐项操作执行记录 |
| agent_events | run_id、sequence、type、data | 用户可读工具活动与审批时间线 |
| audit_logs | actor/kb/run/plan/operation IDs、action、entity_id、before/after、result | 手动/Agent 业务变更可追溯 |
| undo_records | run_id、entity_type/id、before、after_version、status | Agent 撤销快照及版本冲突检查 |

## 运行配置与密钥

迁移 `04_runtime_configuration` 创建 `app_configurations`。没有记录时，公开配置 revision 为 0，运行参数来自后端启动环境；首次保存建立 `id=runtime,revision=1` 的单例，持久化当时完整的模型及 processing 配置。`values` 采用后端扁平字段名，如 `llm_model`、`embedding_dimension`、`chunk_size_tokens`；不包含 API Key，也不能通过设置 API 写入数据库连接或存储路径等基础设施参数。

`secrets` 仅包含 `llm_api_key` 与 `embedding_api_key` 的 Fernet 密文。保留的环境密钥也会在保存时加密；显式清除保存空字符串的密文，保证后来读取时不会重新启用环境旧密钥。公开 DTO 只有 `api_key_configured` 布尔值，不返回原文或密文。

更新通过 `UPDATE ... WHERE id='runtime' AND revision=<读取版本>` 进行条件写入，成功后 revision 加一；并发修改仅有一个请求成功。首次并发创建由单例主键唯一性阻止重复。revision 用于乐观并发控制，表中只保留当前配置；没有历史版本、配置变更审计或自动密钥轮换记录。

加密主密钥位于 `RUNTIME_CONFIG_DIR/master.key`，默认本地为 `.data/runtime/master.key`，Compose 为共享 `runtime` 私有卷的 `/app/runtime/master.key`。初始化先以 `O_EXCL` 创建私有临时文件、写入并同步，再用原子硬链接发布完整主密钥；并发初始化不会覆盖已存在主密钥。Linux 文件权限为 0600；Windows 由宿主账户及目录 ACL 管理访问。API 和 worker 必须使用同一数据库及同一份 master.key，前端不挂载此卷。

备份恢复必须配对保留数据库和 runtime 卷；仅数据库备份无法解密设置密钥，仅 runtime 卷也不包含配置记录。主密钥缺失或损坏时，系统明确报错并停止相关运行配置读取，不自动创建替代密钥或退回环境凭据。恢复匹配的原 master.key 后可继续读取；永久丢失时无法恢复既有密钥，需要管理员明确重置配置记录后重新配置提供方，不能用新的随机 key 覆盖原文件来恢复。

任务不持久化配置原文、密钥或历史配置快照到 `ingestion_jobs.payload`、事件表或 Agent checkpoint。每次任务领取的运行配置只在该执行尝试的内存中持有，重试/租约恢复会读取当时最新配置；具体生命周期见 [architecture.md](architecture.md)。

## 关联与隔离

`knowledge_bases → folders/documents/tags` 是知识隔离根。文档最多属于一个文件夹，`folder_id = null` 代表未分类；标签是多对多。章节和 chunk 同时记录 KB ID，向量行也携带 KB ID，使 SQL 检索可以在候选排序之前约束授权范围。

PostgreSQL 通过 `(id,kb_id)` 唯一键及复合外键强制以下关联同库：文件夹父子、文档文件夹、章节文档、chunk 文档/章节、向量 chunk、document_tags 文档/标签。服务层另外校验目录环、目标存在性、软删除可见性与调用方角色。父目录自身检测还有 check constraint；任意深层环由服务目录树遍历拒绝。

有效文件夹同级重名策略为 `lower(trim(name))` 唯一，根目录使用 coalesce(parent_id,'')；软删除目录不占用有效名称。标签使用服务归一化后的 normalized_name 唯一，不依赖模型随机命名。

## 来源锚点

- PDF：`page_start/page_end`，从 1 开始；目录或字号启发式标题作为章节标题。
- DOCX：`paragraph_start/paragraph_end`，标题、段落和表格行按文档顺序保存；不生成页码。chunk 的段落范围可以覆盖所在标题节，避免伪造更细精度。
- Markdown/TXT：`line_start/line_end`，从 1 开始；Markdown 标题记录层级关系。
- 章节 anchors 额外保存原始解析文本的 `source_start/source_end`，便于 worker 在解析完成而 chunk 尚未提交的崩溃窗口重建。chunk 自身持有准确 source_start/source_end。

## 状态、幂等与并发

文档独立保存 parse/index/summary/classification 状态。解析 ready 不要求模型配置；AI 阶段可为 unconfigured 或 failed，任务以 partial_ready 结束并保留本地可用产物。job 的 queued/running/retry_wait/completed/partial_ready/failed/cancelled 与 stage 分开保存，不以单一“处理中”掩盖失败。

worker 领取通过行锁与 SKIP LOCKED，租约过期可恢复；attempts 与 next_attempt_at 限制自动重试。向量每批提交，`(chunk_id,profile_id)` 唯一防重复保存；网络请求完成但数据库尚未提交时崩溃，仍可能再次发出付费请求，通用兼容接口无法提供跨服务原子性。

交互与入库通道的每个并发任务独立持有 Session、owner 和心跳；领取同一文档的任务时同时检查活动任务并锁定文档，防止 ingest/reindex 并行重写同一产物。`EmbeddingProfile.fingerprint` 唯一与嵌套事务处理并发首次创建；冲突后复用已存在 profile，不回滚其他任务状态。任务并发数是 worker 启动参数，不新增持久化并发计数表；模型调用限额在各进程内共享，不是数据库全局信号量。

聊天的 `retrieval.execution` 保存阶段、公开标签、状态、真实耗时与命中数量等信息；`retrieval.stream_sequence` 保存最新消息事件水位。首个片段及后续短批次在同一事务中更新正文和事件，token 的 `offset` 使用 UTF-16 字符位置，便于浏览器与消息快照对齐。候选 `message_citations` 在生成前保存，完成时删除未使用的候选，来源序号不因列表排序重编号。取消、租约移交与删除会话在持久状态中区分，浏览器断开订阅不改变任务状态。

知识库、目录、文档、标签和计划使用 version；人工更新、审批、建议应用、撤销检查版本。Agent 一次审批读取最终 payload 和 base_versions，在事务中执行元数据变更并保存审计、撤销记录；撤销检查 after_version，防止覆盖后来的人工作业。

删除知识库、文件夹和文档先使用 deleted_at。软删除保留文件原件，恢复后重新进入可见性范围。回收站列表直接查询这些状态，不另建 trash_records；已删除知识库整体显示，其内部资源不重复计入独立文档/目录分类。

确认永久删除后，事务按外键顺序移除引用、向量、chunk、章节、建议、标签关联、任务、相应审计与撤销记录及目标实体；整体删除 KB 时再移除 Agent 关联及 membership。若恢复状态已改变、存在执行中任务或其他相关事务持锁，则拒绝删除。保留的聊天正文不会被删除，但对应来源引用已不可用，永久删除无法通过恢复接口撤销。

迁移 `05_storage_deletions` 创建 `storage_deletions`，与上述数据库删除在同一事务写入原文件待清理记录。`storage_key` 唯一避免重复排队；`owner_id` 用于仅清理当前确认用户的项目，不设文档/KB 外键，确保父资源删除后仍能重试。请求提交元数据后，每次最多处理 64 条已确认记录，成功后删除记录；失败递增 attempts 并保存脱敏错误。API 返回剩余数量，用户再次确认清空时重试；没有后台自动删除或时间到期删除。文件清理仅针对 `<kb_uuid>/<document_uuid>/original` 的具体文件，拒绝越界和目录符号链接/联接。

## Embedding 与索引

fingerprint 由 Embedding base URL、模型名称和配置维度生成，排除 API Key。每个向量在保存前校验实际长度与数值；检索仅查询当前 fingerprint 对应的 active profile。切换维度后旧向量可以保留，但不会混入新 profile 检索。显式 reindex 任务只补新 profile 向量，不重新解析、不重新生成摘要。

生产数据库使用 pgvector `vector` 不固定列维度，通过 profile 与程序验证隔离不同维度。当前实现精确 cosine `<=>`，未创建 HNSW；trigram GIN 索引用于中文文件名和正文关键词检索。小规模 Demo 优先保证范围、引用和维度正确性。

## checkpoint 专用 schema

`agent_checkpoints` 由 `langgraph-checkpoint-postgres` 安装版本的 `PostgresSaver.setup()` 幂等管理，连接 search_path 指向 `agent_checkpoints,public`。checkpoint 保存 LangGraph 的 interrupt/resume 状态；业务计划和消息不依赖 checkpoint 表结构，审计/撤销也独立于 checkpoint。

数据库备份需要同时包含 public 业务 schema 与 agent_checkpoints schema，文件备份还需另行保存 uploads 和 runtime 卷。仅备份数据库不会包含原始附件，也不能独立恢复加密的提供方密钥。
