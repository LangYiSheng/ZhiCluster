# API 说明

本文按实际 FastAPI OpenAPI 路由核对，当前共 **60 个 HTTP 操作**。完整输入及响应模型以运行后的 `http://localhost:8000/openapi.json` 为准；Swagger 位于 `http://localhost:8000/docs`。

Web 代理将 `/api` 原样转发至 API 服务。业务路由统一使用 `/api` 前缀；OpenAPI 和 Swagger 使用上面的 API 直连地址。

## 身份、错误与并发

- 本地免登录身份由后端固定 `demo_user` 上下文取得；不接受浏览器提供的 `user_id`。权限角色预留 owner/editor/viewer，所有知识库资源访问经过服务层检查。
- API 与 Compose 默认只用于回环访问；Origin 与 Host 有严格限制。
- JSON 错误示例：`{"code":"version_conflict","message":"数据已被修改，请刷新后重新操作","details":null,"request_id":"..."}`。常用状态：400 输入/范围错误、403 权限拒绝、404 不存在或已删除、409 状态/版本冲突、422 Pydantic 输入校验、503 模型未配置、502 模型服务错误。
- 可编辑实体返回 `version`；PATCH 可以携带当前版本，避免覆盖后续更改。Agent 计划编辑必须提供 `version`，批准必须提供 `plan_version`。
- 元数据写入先取得知识库 namespace 锁，再锁定实体；目录树循环、同级重名、标签归一化与别名冲突在事务中校验。
- 数据库依赖使用 FastAPI `scope="function"`，提交在响应发出前完成，提交失败不会先向浏览器报告成功。SSE 使用独立短会话逐次鉴权，避免占用请求事务。

## 知识库、文件夹与标签

| 方法 | 路径 | 请求 / 行为 |
| --- | --- | --- |
| GET | `/api/knowledge-bases` | 可选 `include_deleted=true`；返回可访问知识库数组 |
| POST | `/api/knowledge-bases` | `{name, description?}`；201 |
| GET | `/api/knowledge-bases/{kb_id}` | 读取可访问的未删除知识库 |
| PATCH | `/api/knowledge-bases/{kb_id}` | `{name?, description?, version?}`；owner |
| DELETE | `/api/knowledge-bases/{kb_id}` | 软删除知识库；owner |
| POST | `/api/knowledge-bases/{kb_id}/restore` | 恢复知识库；owner |
| GET | `/api/knowledge-bases/{kb_id}/folders` | 可选 `include_deleted=true` |
| POST | `/api/knowledge-bases/{kb_id}/folders` | `{name, parent_id?}`；201 |
| PATCH | `/api/folders/{folder_id}` | `{name?, parent_id?, version?}`；`parent_id:null` 移到根目录 |
| DELETE | `/api/folders/{folder_id}` | 软删除子树及当前子树内未删除文档 |
| POST | `/api/folders/{folder_id}/restore` | 恢复该文件夹；先恢复父目录，文档单独恢复 |
| GET | `/api/knowledge-bases/{kb_id}/tags` | 返回本库标签数组 |
| POST | `/api/knowledge-bases/{kb_id}/tags` | `{name, color?, aliases?}`；201；颜色为 `#RRGGBB` |
| PATCH | `/api/tags/{tag_id}` | `{name?, color?, aliases?, version?}` |
| DELETE | `/api/tags/{tag_id}` | 删除标签及关联，递增受影响文档版本 |

文件夹同级名称按 Unicode NFKC、大小写和空白归一化检查。标签名称及别名使用同样的归一化策略。跨库文件夹/标签引用被拒绝。

## 文档与上传

| 方法 | 路径 | 请求 / 行为 |
| --- | --- | --- |
| GET | `/api/knowledge-bases/{kb_id}/documents` | 分页列表，见下文 |
| POST | `/api/knowledge-bases/{kb_id}/uploads` | multipart 多文件上传；返回逐文件结果及数据库作业 |
| POST | `/api/documents/batch` | `{kb_id, document_ids, action, folder_id?, tag_ids?, tag_mode?}` |
| GET | `/api/documents/{doc_id}` | 元数据、各阶段状态、摘要、版本和 `tag_ids` |
| PATCH | `/api/documents/{doc_id}` | `{display_name?, folder_id?, tag_ids?, version?}` |
| DELETE | `/api/documents/{doc_id}` | 软删除，保留原文件 |
| POST | `/api/documents/{doc_id}/restore` | 恢复文档，原目录必须可用 |
| GET | `/api/documents/{doc_id}/sections` | 顺序章节，包含真实来源 `anchors` |
| GET | `/api/documents/{doc_id}/content` | `{text, sections}` |
| GET | `/api/documents/{doc_id}/download` | 鉴权下载；`inline=true` 仅对 PDF 内嵌生效 |
| GET | `/api/documents/{doc_id}/suggestion` | 持久化分类建议或 `null` |
| POST | `/api/documents/{doc_id}/suggestion` | `{action:"apply"|"reject", payload?}`；应用前再次检查文档版本及目标归属 |

列表参数：`folder_id=root` 表示未分类；也可指定实际文件夹及 `include_descendants=true`。`tag_ids` 是逗号分隔 ID，按交集筛选；另支持 `ext`、`status`（解析状态）、`trash=true`、`sort=name|date|type`、`page`（默认 1）、`page_size`（默认 50，最大 200）。响应为 `{items,total,page,page_size}`。

上传字段为重复的 `files`、可选 `folder_id`、`duplicate_policy=skip|copy`。同库 SHA-256 相同的文件默认返回 `duplicate`，不会静默再次解析/向量化；使用 `copy` 明确保留副本。响应 `{items,jobs}` 中每项状态为 `queued|duplicate|error`。单文件失败不会伪装整批成功，调用方应逐项展示结果。默认单文件 50 MiB、整批 200 MiB、最多 20 个文件，可配置。

批量 `action` 为 `move|tags|trash|restore`；标签 `tag_mode=set|add|remove`。整个批次通过同一事务应用，跨库 ID 被拒绝。

## 回收站与永久删除

| 方法 | 路径 | 请求 / 行为 |
| --- | --- | --- |
| GET | `/api/trash` | 当前用户拥有的已删除资源，按类型搜索、分页；详见下文 |
| POST | `/api/trash/purge` | `{kind,ids?,confirm:true}`；永久删除已确认项目并尝试清理原件 |

列表参数为 `kind=document|folder|knowledge_base`（默认 document）、`q`（最长 200 字符）、`page`（默认 1）、`page_size`（默认 30，最大 100）。响应 `{items,total,counts,pending_file_cleanup}`；`counts` 包含三个类型各自的总数，不受本次搜索词影响。条目含 `{id,name,kb_id,kb_name,kind,deleted_at}`，知识库条目另有 `document_count/folder_count`。已删除知识库的内部文档及文件夹不再单独计入前两个分类，避免重复展示。恢复仍使用各资源原有的 `/restore` 接口。

永久删除 `kind` 支持上述三个类型及 `all`。选择类型时 `ids` 必填、最多 200 个；`kind=all` 清除当前用户拥有的全部回收站内容，无需传 ID。`confirm` 必须为布尔值 true，省略或 false 返回 422。删除前检查 owner、软删除状态、文件夹子树和运行任务；项目已恢复、任务仍在执行或资源正在使用时不会部分完成，分别返回 `active_resource`、`task_running` 或 `trash_busy` 等 409。ID 不存在、不在回收站或没有管理权限返回 `404 trash_not_found`。

成功示例：

```json
{
  "deleted": {"document": 3, "folder": 1, "knowledge_base": 0},
  "pending_file_cleanup": 0
}
```

`deleted` 是已提交的元数据删除数量。其关联来源、向量、任务和必要的审计/撤销记录同时移除，永久删除不能恢复。原文件通过同一事务建立的 `StorageDeletion` 记录清理，每次请求只处理该用户最多 64 条。文件暂时被占用或路径不合法时保留待清理记录，`pending_file_cleanup` 返回剩余条数；再次明确提交 `kind=all,confirm=true` 可重试，包括回收站列表已为空时。没有后台自动清理或定时删除。

## 运行状态、模型与入库任务

| 方法 | 路径 | 请求 / 行为 |
| --- | --- | --- |
| GET | `/api/health` | 进程存活 `{status,version}` |
| GET | `/api/ready` | 检查数据库及 demo 身份初始化 |
| GET | `/api/settings/model-status` | 两个独立模型配置状态、维度、重建提示、工具能力配置；不返回密钥 |
| GET | `/api/settings/config` | 当前运行配置及 `revision`；密钥仅返回是否配置 |
| PUT | `/api/settings/config` | `{revision,llm?,embedding?,processing?}`；版本校验后保存，新请求/新领取任务生效 |
| POST | `/api/settings/test-models` | 可选 `{scope,draft}`；仅测试指定能力且不保存；空请求保持三项测试 |
| POST | `/api/settings/models` | `{scope:"llm"\|"embedding",draft?}`；使用所选连接 GET `/models`，返回 `{models:[{id}]}`，不保存 |
| POST | `/api/settings/rebuild-embeddings` | `{kb_id}`；为已解析文档创建 reindex 后台任务 |
| GET | `/api/ingestion/jobs` | 可选 `kb_id`、`document_id`、`group=attention|active|completed`，返回可访问库最新 200 个任务；聊天任务仅显示自己的未删除会话 |
| GET | `/api/ingestion/jobs/{job_id}` | 持久状态、阶段、进度、尝试次数、错误 |
| POST | `/api/ingestion/jobs/{job_id}/retry` | 重试终态任务；运行中的任务返回 409；已有计划的 Agent 任务应打开计划或新建整理 |
| POST | `/api/ingestion/jobs/{job_id}/cancel` | 取消 queued/running 任务；聊天解除会话忙状态，Agent 同步运行状态并阻止计划落库及审批 |
| GET | `/api/ingestion/jobs/{job_id}/events` | 持久化 SSE，支持游标 |

未配置模型时解析、阅读、管理及关键词检索仍可使用；AI 阶段显示 `unconfigured`/`partial_ready`，不会返回假摘要或假向量。Embedding 重建仅处理向量，目录/标签/改名不会触发重新解析。

### 运行配置读取与保存

模型目录使用当前所选连接的草稿或已保存配置。省略密钥时，同一服务地址可复用后端密钥；地址改变且未提供新密钥时返回 `422 model_list_key_required`，不会发送请求。获取无需预先选择模型，不探测生成能力；空列表返回 `models:[]` 与提示，不凭名称分类。鉴权失败、服务不支持、超时或无效响应均返回脱敏错误，保留前端手动填写入口。

`GET /api/settings/config` 返回示例：

```json
{
  "revision": 0,
  "llm": {
    "base_url": "", "model": "", "api_key_configured": false,
    "timeout_seconds": 120, "max_retries": 2, "supports_tools": false
  },
  "embedding": {
    "base_url": "", "model": "", "api_key_configured": false,
    "timeout_seconds": 60, "max_retries": 2, "dimension": 1024, "batch_size": 32
  },
  "processing": {
    "chunk_size_tokens": 800, "chunk_overlap_tokens": 100,
    "max_ingestion_attempts": 3, "max_concurrent_model_calls": 3,
    "summary_input_tokens": 6000, "summary_max_calls": 80
  }
}
```

尚未通过网页保存时 `revision=0`，值来自后端启动环境默认值。首次保存会持久化完整的有效运行配置，包括保留的环境密钥；此后这些字段以数据库记录为准。数据库连接、监听地址、CORS、上传存储路径、上传大小限制、worker 轮询、租约及两个任务通道并发参数仍由启动环境控制，不属于此 API 的可写字段。`WORKER_INGESTION_CONCURRENCY` 默认 3，`WORKER_INTERACTIVE_CONCURRENCY` 默认 1，变更需重启 worker。

`processing.max_concurrent_model_calls` 是单进程、相同连接配置网关共享的模型调用额度，和 worker 任务线程数量分别控制。限额至少为 2 时后台任务保留一个交互槽；API 和 worker 各自执行限额，不构成服务商账户或整个部署的全局上限。

`PUT` 必须提供读取时的 `revision`，其余 section 和字段可部分提交。成功返回与 GET 相同的公开结构，revision 加一；保存提交在成功响应发出前完成。示例只修改聊天模型和超时，同时保留密钥：

```json
{
  "revision": 1,
  "llm": {"model": "your-chat-model", "timeout_seconds": 90, "api_key": ""}
}
```

LLM 与 Embedding 各自独立处理 `api_key`：省略、`null` 或空字符串表示保留；非空字符串表示替换；`clear_api_key:true` 显式清除。清除后不会重新使用环境中的旧密钥。非空新密钥与清除标志同时出现返回 422。密钥前后空白会被去除，密钥内部空白及控制字符被拒绝；密钥最大 4096 字符。响应不包含密钥原文或密文，`api_key_configured` 为只读字段，不应从 GET 原样回传到 PUT。

服务地址可以为空，非空时仅允许 HTTP/HTTPS、必须有 hostname，不允许 URL 用户名/密码、查询参数、片段或内部空白；允许明确的本地模型服务地址。模型名称可为空、最长 512 字符。数值范围如下：

| 字段 | 范围 / 约束 |
| --- | --- |
| `llm/embedding.timeout_seconds` | 1–600，有限数值 |
| `llm/embedding.max_retries` | 整数 0–4 |
| `embedding.dimension` / `batch_size` | 整数 1–16000 / 1–256；维度不支持 0 自动推断 |
| `processing.chunk_size_tokens` / `chunk_overlap_tokens` | 整数 128–8192 / 0–2048，且重叠严格小于分块大小 |
| `processing.max_ingestion_attempts` / `max_concurrent_model_calls` | 整数 1–10 / 1–16 |
| `processing.summary_input_tokens` / `summary_max_calls` | 整数 1024–200000 / 1–100 |

旧 revision 返回 `409 configuration_conflict`，调用方应重新读取并让用户核对后再保存，不应自动覆盖。非法字段、类型、范围或地址返回 422，跨字段分块约束返回 `invalid_configuration`。输入错误不会回显提交值。

### 草稿连接与能力测试

`POST /api/settings/test-models` 可传 `scope=llm|embedding|tool_calling`，每次仅执行对应的一项探测。`draft` 使用保存接口的三个 section 结构，不含 revision，密钥保留/替换/清除策略相同；省略部分基于当前已保存配置补齐。示例：

```json
{
  "scope": "llm",
  "draft": {"llm": {"base_url": "http://localhost:9100/v1", "model": "draft-model", "api_key": ""}}
}
```

返回对应 section，例如 `{"llm":{"ok":true,"configured":true,"message":"聊天模型连接成功","elapsed_ms":12.3}}`。Embedding 成功额外返回实际 `dimension`，并与配置维度校验；工具测试返回 `supported`。提供方拒绝、连接失败或格式不兼容时，单项 `ok=false` 并返回可理解错误；未配置密钥不会发送模型请求。

无 body 或 `{}` 保持原有聊天、Embedding、Tool Calling 三项测试契约。测试会真实请求所配置的服务，不保存 draft、不递增 revision，也不自动保存 `llm.supports_tools`；用户确认结果后另行保存。保存本身不会发起模型请求。

已有加密配置却缺少或无法读取 master.key 时，相关接口返回 `503 configuration_key_unavailable`；密钥文件不匹配或密文失效时返回 `503 configuration_decryption_failed`。应恢复正确私有 runtime 卷，不能通过生成新 key 静默回退。`/api/ready` 只检查数据库与 actor，不代表模型或加密配置可用。

## 搜索与问答

`POST /api/search` 请求示例：

```json
{
  "query": "中文知识检索",
  "kb_ids": ["knowledge-base-uuid"],
  "folder_ids": [],
  "include_descendants": true,
  "tag_ids": [],
  "tag_match": "all",
  "document_ids": [],
  "exts": ["md", "pdf"],
  "mode": "hybrid",
  "limit": 30,
  "offset": 0
}
```

另支持 ISO 8601 `date_from/date_to`。未传 KB ID 时使用当前 actor 可访问知识库；指定不可访问 KB 返回 403。权限、未删除状态、文件夹及标签范围在候选 SQL 中限定；Embedding 或证据重排网络等待后重新复核原范围。`mode=keyword|hybrid`；无 Embedding 或模型不兼容时返回真实的 `mode=keyword` 和 `notice`。响应 `{items,total,mode,notice,elapsed_ms,kb_ids,reranking}`；每项包含真实 `document_id/chunk_id/section_id/anchors/snippet/content/score`。`total` 是本次最多 600 个融合候选的数量，并非全库穷举计数；`limit` 最大 100。复合问题可将全文和最多两个子问句放入同一次 Embedding 请求。

默认聊天与搜索不调用额外证据筛选模型。搜索请求显式传 `rerank=true` 可在本地排序之后执行一次证据重排，只接受已有候选 ID；最多 8 个候选、4,000 输入字符、400 输出 tokens，超时至多 12 秒且不重试。默认 `reranking.status` 为 skipped；失败时回退本地排序，有效空列表表示没有足够证据。该选项需聊天模型，耗时比默认检索更长。

| 方法 | 路径 | 请求 / 行为 |
| --- | --- | --- |
| GET | `/api/conversations` | 当前用户未删除会话 |
| POST | `/api/conversations` | `{title?,scope?}`；scope 使用搜索过滤字段，保存实际 KB 范围；201 |
| GET | `/api/conversations/{conversation_id}` | 持久化范围及元数据 |
| PATCH | `/api/conversations/{conversation_id}` | `{title}` |
| DELETE | `/api/conversations/{conversation_id}` | 软删除会话，停止进行中的生成 |
| GET | `/api/conversations/{conversation_id}/messages` | 消息、检索观测/执行阶段/事件水位，以及经过权限/删除状态校验的真实 `citations` |
| POST | `/api/conversations/{conversation_id}/messages` | `{content,retrieval_mode?:"direct"或"model"}`；202；默认 direct，创建 assistant 消息和独立后台任务 |
| GET | `/api/conversations/{conversation_id}/events` | 实际执行阶段 progress、合批 token、候选/最终 citation、完成/错误 SSE |

同一会话只允许一个 queued/processing 回复；后续提交返回 409。无任何可访问知识库时创建会话返回 `empty_scope`。答案引用仅从检索上下文 `[S1]` 等白名单标记构造；无效来源标记会被替换。PDF 使用页码锚点，MD/TXT 使用行号，DOCX 使用段落，不虚构 DOCX 页码。不可访问来源返回 `available=false`，不会继续返回其 snippet。

消息的 `retrieval.execution` 保存 `{stage,label,status,elapsed_ms?,source_count?,...}` 阶段列表，`retrieval.stream_sequence` 是该消息最近持久化事件的水位。实际阶段包括 scope、keyword、可选 embedding、ranking、可选 reranking、context、generation；无命中、未配置能力或失败时不会伪造未执行阶段。`progress` 事件携带 `message_id` 和完整 `steps` 快照，`completed/error` 也携带最终步骤；这些内容不包含模型隐藏推理。

`retrieval_mode=model` 只影响本条消息，不修改保存的会话范围或连接配置。已声明支持工具的模型使用只读 `search_knowledge({query})`；未声明时使用明确标识的 JSON 检索规划。最多两轮规划和三次实际搜索尝试（失败也计数），规划请求每轮至多12秒、不重试。重复搜索词去重，失败在剩余预算内回退直接检索。模型不能传入范围字段；每次模型和检索等待后复核用户原选范围及权限。执行阶段可含 `query/tool_name/call_id/round`，检索观测保存 `retrieval_strategy` 和 `model_retrieval`，不返回模型隐藏推理。默认 direct 不增加规划调用。

生成前 `citation` 可携带 `candidate:true`，此时消息快照也能读到真实候选引用。回答完成时只保留正文实际使用的引用。token 指定对应 `message_id` 与 UTF-16 字符 `offset`，首次片段立即保存，后续约 120 ms 或 256 字符合批；调用方应将片段合入同一消息，避免把快照中的正文再拼一遍。前端以约 60 ms 的节奏更新 Markdown，完成后折叠过程并保留紧凑来源列表；代码和链接内的 `[Sx]` 不转换成引用按钮。

## 智能整理与整批审批

统一整理审阅使用以下接口；均按当前 actor 的知识库权限过滤，生成建议或方案本身不改变文档目录和标签。

| 方法 | 路径 | 请求 / 行为 |
| --- | --- | --- |
| GET | `/api/review/suggestions` | 可选 `kb_id/document_id/status/page/page_size`；status 为 pending/applied/rejected/all；返回 items、total、分页及 counts，含当前版本、现有/目标目录、标签、权限与冲突状态 |
| POST | `/api/review/suggestions/{id}` | `{action:apply或reject,document_version,payload?}`；应用使用最终编辑稿，返回审计 run_id 与撤销能力 |
| POST | `/api/review/suggestions/batch` | `{action,items:[{suggestion_id,document_version,payload?}]}`；至多 100 项；返回每项成功、冲突或错误，响应顺序与输入一致 |
| POST | `/api/review/suggestions/{id}/refresh` | `{document_version}`；仅 pending 建议；排队仅分类任务，不重做解析、摘要或向量；返回 job_id |
| POST | `/api/review/plans` | `{kb_id,goal?,document_ids?}`；范围最多 50 份文档；201 返回 run；后台生成有界 JSON 整理方案，已有生成任务时 409 |

建议应用重新检查文档版本及同库目标；批量使用独立 savepoint 并按知识库固定顺序取得锁。已过期建议返回冲突，调用方可让用户重新生成。分类与批量整理沿用下面的计划审批、编辑及撤销接口。新整理任务 kind 为 organize，使用后台模型额度，不占聊天任务通道。

| 方法 | 路径 | 请求 / 行为 |
| --- | --- | --- |
| GET | `/api/agent/runs?kb_id=...` | 当前用户最近 50 次整理；省略 kb_id 时跨可编辑知识库 |
| POST | `/api/agent/runs` | `{kb_id,goal}`；201；仅排队，未配置聊天模型时 503 |
| GET | `/api/agent/runs/{run_id}` | 运行状态、完整计划、事件及操作审计 |
| GET | `/api/agent/plans/{plan_id}` | `{id,version,status,payload,result,...}` |
| PATCH | `/api/agent/plans/{plan_id}` | `{version,operations,summary?}`；保存完整编辑后的操作列表 |
| POST | `/api/agent/plans/{plan_id}/approve` | `{plan_version,confirm_high_risk:false}`；一次批准最终版本 |
| POST | `/api/agent/plans/{plan_id}/reject` | 拒绝计划，零业务副作用 |
| POST | `/api/agent/runs/{run_id}/undo` | 检查版本与后续变更后撤销整次整理 |
| GET | `/api/agent/runs/{run_id}/events` | 活动、计划等待审批、执行结果 SSE |

计划操作含稳定 `operation_id`、`type`、`target_ids`、`params`、`description`、`dependencies`、`enabled`、`reversible`。支持 `create_folder`、`move_documents`、`update_document_tags`、`rename_document`、`rename_folder`、`trash_documents`、`trash_empty_folders`、`delete_tags`。临时文件夹使用 `ref:<创建操作ID>`，并显式依赖创建操作。编辑可以取消操作及调整目录/标签等参数；操作类型和身份不可替换，删除操作只能保留或取消原规划目标。

`trash_empty_folders` 和 `delete_tags` 的 params 为 `{}`，target_ids 分别为同库目录或标签。空目录在规划、审批及最终执行时必须无有效文档和子目录；不支持同方案先清空非空目录再删除。标签删除移除标签及其文档关联，预览含受影响文档。服务端保存 `base_tag_links` 与关联文档版本，最多500条关联；这些快照不接受客户端编辑。新增关联、数量漂移或版本变化均拒绝执行。两类操作均属高风险，需要额外确认；撤销恢复原目录或原标签ID、颜色、别名和关联，同名冲突或后续人工修改时拒绝覆盖。

软删除风险由后端重新计算；必须额外提交 `confirm_high_risk=true`。跨库操作、审批期间版本变化、重复/非法依赖被拒绝。重复批准已完成的同一版本返回持久结果，不会再次修改实体。撤销遇到后续人工修改返回 `undo_conflict`，不覆盖新工作。

## SSE 恢复

创建聊天/Agent 后使用 GET SSE 订阅，不能用 EventSource 发送 POST JSON。所有事件含 `id`（持久 sequence）及 JSON `timestamp`。示例：

```text
id: 12
event: token
data: {"sequence":12,"timestamp":"2026-10-22T10:00:00+00:00","message_id":"...","token":"知识","offset":0}

```

首次订阅可用 `?after=12`；重连也支持 `Last-Event-ID: 12`。事件有 `status/progress/token/tool_start/tool_end/plan_ready/approval_required/citation/completed/error`，具体按资源类型使用。连接断开不会取消 worker；应重新读取任务/消息/计划状态，再继续订阅。聊天可结合消息事件水位、事件 sequence 和 token offset 丢弃已保存片段；切换会话时关闭订阅并忽略旧连接尾事件，不取消后台执行。删除会话会结束当前 owner 的生成并释放租约；单纯 owner 交接不会让旧执行者覆盖新结果。订阅过程中每次轮询重新验证资源权限，权限变化后发送 error 并关闭。聊天来源事件重放会再次遮蔽已删除/不可访问文档的名称与 snippet。
