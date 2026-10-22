# 开发热更新验收

验收日期：2026-10-22。

## 当前结果

| 验证项 | 状态 | 证据 |
| --- | --- | --- |
| 完整 Compose 与开发 override 合并有效 | PASS | `docker compose -f compose.yaml -f compose.dev.yaml config --format json`，退出码 0 |
| API `uvicorn --reload` 与 `/app/app` 源码挂载 | PASS | 合并配置核对 |
| worker `watchfiles --filter python`、独立开发依赖镜像和源码挂载 | PASS | 合并配置与 Dockerfile.dev 核对 |
| Vite 开发镜像、src/public 挂载、5173 容器端口替换生产 80 | PASS | 开发最终仅发布 `127.0.0.1:3000 → 5173` |
| 容器内 Vite API 代理 | PASS | `frontend/Dockerfile.dev` 设置 `VITE_API_PROXY=http://api:8000` |
| 自动化只读检查脚本 | PASS | `pwsh -NoProfile -File scripts/verify-dev.ps1`，11 项 PASS，退出码 0 |
| 开发 worker/web 镜像可构建 | PASS | `docker compose -p zhicluster-dev-cache -f compose.yaml -f compose.dev.yaml build worker web`，两个镜像 Built、退出码 0；独立标签预热，不启停服务 |
| 开发 Compose 完整启动 | PASS | `docker compose -f compose.yaml -f compose.dev.yaml up --build -d` 退出码 0，migrate 成功，api healthy，worker/web started |
| 三个开发进程真实热更新 | PASS | `pwsh -NoProfile -File scripts/verify-dev.ps1 -Runtime` 退出码 0，共 19 项 PASS；CSS HMR 保留页面 sentinel，API PID 与 worker identity 均更新，重载后 ready 200 |

## 可重复脚本

默认只读检查，不启停服务、不修改源码：

```powershell
pwsh -NoProfile -File scripts/verify-dev.ps1
```

先按 README 启动开发 Compose，再显式执行运行时验收：

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up --build -d
pwsh -NoProfile -File scripts/verify-dev.ps1 -Runtime
```

脚本需要前端依赖和 Playwright Chromium。它在浏览器加载实际 Vite 页面，通过 CSS 变量探针验证 HMR，并检查页面内存 sentinel 没有消失，证明更新没有依靠整页刷新。然后临时新增一个不被导入的 Python 文件，观察 API server PID 和 worker identity 都改变，并重新检查 `/api/ready`。

源码探针在 finally 中移除，不覆盖其他并发编辑；脚本不主动启动/停止服务，运行后保留开发站点。探针会触发后端重载，因此应在无其他验收任务依赖当前服务时执行。

## README 命令审阅

启动、迁移和备份命令已按当前 Compose 文件核对。数据库 `pg_dump -Fc -f /tmp/zhicluster.dump` 在容器内生成二进制文件，再使用 `docker compose cp` 导出，避免 Windows PowerShell 旧版的重定向编码问题。备份需要另行保存 uploads 卷；仅数据库备份没有原始附件。

主机开发需要为 API 和 worker 两个终端都设置相同 DATABASE_URL/UPLOAD_ROOT；Docker 开发镜像的 Vite 代理目标使用服务名 api，主机 Vite 默认代理 127.0.0.1:8000。新终端应从项目根目录进入对应子目录。

本设备首次 Runtime 实测发现 Windows Docker Desktop 的 bind mount 没有传递 CSS 文件事件：Vite HMR WebSocket 已连接，CSS 变量 30 秒内未更新。脚本清理探针后，在 `compose.dev.yaml` 为 web 加入 `CHOKIDAR_USEPOLLING=true` 与 `CHOKIDAR_INTERVAL=300`，为 API/worker 加入 `WATCHFILES_FORCE_POLLING=true`。安装版 Vite 内置 chokidar 源码也确认支持这两个 CHOKIDAR 环境变量。

随后实际执行：

```powershell
docker compose -f compose.yaml -f compose.dev.yaml up -d api worker web
pwsh -NoProfile -File scripts/verify-dev.ps1 -Runtime
```

结果为 19 项 PASS、退出码 0。浏览器 CSS 更新时内存 sentinel 仍在，证明没有依赖整页刷新；新增 Python 文件后 API server 进程和 worker 身份分别变化。脚本返回 `runtime: PASS`、`source_probes: restored`、`services: left running`。生产配置没有加入 polling。

Playwright 使用与项目 E2E 相同的 `channel: 'chromium'`，复用已安装的完整 Chromium；不依赖本设备未下载的独立 headless-shell 包。

已通过 Context7 查阅 [Vite 7.3.5 官方 server.watch 文档](https://github.com/vitejs/vite/blob/v7.3.5/docs/config/server-options.md#serverwatch)：Windows 程序编辑 WSL2/Docker Windows 文件系统挂载内容时可能没有文件事件，文档提供 `usePolling: true` 作为解决方式。是否需要启用以当前设备实际验收为准。
