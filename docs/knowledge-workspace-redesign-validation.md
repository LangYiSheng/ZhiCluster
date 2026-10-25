# 资料浏览、模型选择与设置改造验收

日期：2026-10-25。依据本次六张参考图和完整功能目标逐项验收。

## 已实现范围

| 要求 | 实现与验证 |
| --- | --- |
| 知识库标题置顶、类似资源管理器浏览 | 图标、标题和描述置顶；当前层文件夹与文件列表；面包屑、前进后退；桌面、390px 手机及844×390横屏浏览器验证 |
| 搜索移动到资料面板、筛选归入搜索 | 面板内搜索当前知识库文件名与正文；类型、状态、标签筛选仅在搜索视图显示；保留 Ctrl/Cmd+K 全文检索 |
| 排序与添加菜单 | 更新时间、创建时间、大小、类型、名称；本地文件、本地文件夹、新建文件夹，均经真实菜单操作验证 |
| 本地文件夹 | 21份不同内容的文件真实上传，保留目录层级；逐文件提交避开批次数量限制；单项失败继续、重复副本、导入中导航等有行为测试 |
| 编辑知识库 | 名称、描述、八种图标、预设/自定义颜色、单一嵌入模型和明确维度；真实保存并回读；打开时版本与未保存草稿有并发测试 |
| 单库嵌入模型 | 入库和查询均采用知识库绑定模型；不同维度按profile分组生成query向量后融合；模型变更后明确提示重建 |
| 多个对话模型 | 同一服务启用多个模型、设置默认模型、添加自定义ID；输入区可选，后端校验允许列表并持久化当次选项，真实HTTP验证实际调用 |
| 快速/思考 | 快速先检索再回答；思考通过有界只读工具轮次查阅；公开正文与工具结果之间继续输出，不读取服务方内部推理字段 |
| 紧凑查阅过程 | 默认单行折叠，显示真实工具查阅次数，可手动展开阶段、查询和耗时 |
| 设置小标签和预览 | 聊天/向量子标签；六套明暗配色；整个页面/阅读文本草稿预览，保存才应用；键盘导航和离开拦截有行为测试 |
| 统计 | 单库/全局十项真实指标，支持加载、错误重试、刷新；索引口径对应当前绑定模型 |
| 个人库历史 | 持久化所属kb_id；跨库搜索不改变归属；新库历史为空；过期本地指针不读取其他库消息；旧会话迁移回填已在真实PG验证 |

## 验证结果

- 前端全量：30个文件、174项行为测试通过；TypeScript、ESLint通过。
- 后端启用专用PostgreSQL数据库的全量：461 passed、1 skipped、29 xfailed；Ruff通过。xfail为仓库已有的Unicode检索预期失败，不计作本次通过项。
- 后端补充专项：最终SSE与功能40项通过，真实PG迁移回填和不同维度profile检索2项通过。
- 最后统计修补：12项工作区专项通过；真实PG复测2项通过，覆盖改绑定、重建、片段向量缺失和profile停用后的计数。
- 模型标识边界修补：两处索引/分类模型字段与512字符配置上限统一，新增`07_model_identifiers`迁移。58项定向测试通过，包含SQLite迁移行与引用保留，以及真实PG下284字符嵌入模型、251字符聊天模型的迁移、入库、分类、检索和统计完整链路。
- 浏览器新流程3项通过：真实资料操作和21文件目录导入；新库历史/SPA设置切换/配色与预览/统计及三尺寸菜单；受控HTTP服务下两个聊天模型、两种模式和两个不同维度嵌入模型。
- 浏览器设置专项：1440×900、375×812、844×390截图检查，无水平溢出、页面错误或意外配置写入；正文与辅助文字对比度检查通过。
- 最终浏览器配色复核：浅色rose引用文字4.96、sand为4.89；无页面错误或保存请求，证据为`settings-visual/contrast-final-browser.json`。
- Docker生产构建通过；保留现有大块资源提示，未以调高警告阈值掩盖。

浏览器测试使用独立项目`zhicluster-redesign-check`及独立数据卷（网页13001、API18001、数据库25433）；测试模型连接和密钥均为合成值，完成后恢复初始空配置。日常库未用于写入验收。更新日常服务前保留数据库快照于`.data/backups/`。

## 证据与复跑

- 新浏览器场景：`frontend/e2e/knowledge-redesign.spec.ts`。
- 资料/知识库行为：`DocumentsPane.explorer.test.tsx`、`KnowledgeBaseEditor.test.tsx`及原有文件管理/生命周期测试。
- 对话行为：`ChatModels.test.tsx`、`Chat.test.tsx`、`MessageContent.test.tsx`、`useSessionDraft.test.tsx`。
- 设置行为：`Settings.test.tsx`、`SettingsEnhancements.test.tsx`。
- 后端新场景：`backend/tests/test_workspace_personalization.py`、`backend/tests/test_workspace_postgres.py`。
- 模型字段迁移：`backend/tests/test_model_identifier_migration.py`及`test_workspace_postgres.py`的长模型场景；独立验收库已实际迁移到07，两处字段均为512字符。
- 截图与机器可读结果位于忽略目录`.data/test-runs/`；最终交互场景为`redesign-final-acceptance/`，设置视觉为`settings-visual/`。

PowerShell复跑浏览器新场景（仅使用明确隔离的站点）：

```powershell
$env:E2E_BASE_URL='http://127.0.0.1:13001'
$env:E2E_BROWSER='msedge'
$env:E2E_CONFIG_WRITES='1'
cd frontend
pnpm exec playwright test e2e/knowledge-redesign.spec.ts --reporter=line --output=../.data/test-runs/redesign-acceptance
```

真实云模型的可用性由服务方接口和所选模型能力决定。本次以真实HTTP受控兼容服务验证请求、流、工具调用、索引与引用链路，没有使用或修改日常真实密钥。

## 交付状态

2026-10-25用户明确确认“更新常用服务”后，已将独立站点验收通过的镜像更新到`http://localhost:3000`。API与数据库健康，迁移正常退出，worker正常运行；数据库版本为`07_model_identifiers`，两处模型标识字段均为512字符。

更新前最新数据库快照为`.data/backups/pre-approved-update-20261025-122335.dump`，部署记录和旧镜像回退标签见`.data/deployments/approved-workspace-20261025-122335.json`。更新后核对2个知识库、11份文档、17个文件夹、50个标签、20个会话、32条消息，数量与备份前一致；原有模型配置指纹及上传/运行配置卷映射一致。11份历史原件全部可下载，大小和SHA256均与上传记录相同。

常用站点只读浏览器验收通过：资料标题、搜索筛选、五项排序、三项添加菜单、快速/思考选择、聊天/嵌入模型子标签、六套配色、阅读预览与真实统计。1440×900、390×844、844×390均无水平溢出；无页面异常、失败响应或配置写入。证据位于`.data/test-runs/daily-deployment/results.json`及同目录截图。日常真实云模型未发起收费调用。
