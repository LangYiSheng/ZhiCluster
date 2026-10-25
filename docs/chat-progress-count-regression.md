# 查阅过程计数字段兼容修复

2026-10-25，用户在整理审阅页遇到`queries.filter is not a function`，页面被React Router错误边界替换。

## 原因

旧`embedding`进度事件的`queries`表示查询数量，是正常的number；新的`search_round_summary.queries`表示查询词，是string数组。查阅卡片将两者一律当数组读取，旧消息或尚未到达summary的流式阶段即可触发错误。聊天组件保留挂载时，即使正在看整理审阅页也会受影响。单看`pageerror=0`无法证明正常，因为错误边界会捕获渲染异常。

只读数据库核对发现20个数字字段，全部来自embedding、涉及16条消息；没有数据损坏，清库无法修复之后仍会出现的同类事件。

## 修复

- 前端使用`Array.isArray`读取查询词，兼容正常旧计数；非法容器、空或原始类型步骤、混合查询项及异常范围字段安全跳过，合法查询和真实结果数保留。
- 后端新向量事件改用`query_count`，summary继续使用`queries`数组，避免继续混用。历史记录不改写。
- 浏览器验收必须确认工作区、正确路由和聊天内容存在，并排除错误页，不能仅检查未捕获异常。

定向前端29项、后端71项通过，类型检查和定向ESLint/Ruff通过。证据集中在`.data/test-runs/chat-progress-count-regression/`和`.data/test-runs/review-scope-ui/chat-progress-compat/`；最终全量及部署结果见同目录验收日志与记录。

最终前端全量34文件209项通过；源码预览和隔离打包页面的聊天/审阅浏览器兼容用例各2项通过，断言工作区与目标页面实际存在、错误页不存在，合法搜索词及计数保留。常用服务已更新到同一批镜像，更新前备份为`.data/backups/pre-chat-progress-compat-20261025-234010.dump`。更新后比较资料位置、标签、摘要、建议、模型配置，以及完整消息正文/检索记录和会话范围指纹，均与更新前一致，未清库或改写历史。
