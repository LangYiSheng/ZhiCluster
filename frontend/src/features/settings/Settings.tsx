import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
  CheckCircle2,
  KeyRound,
  RefreshCw,
  Settings2,
  ShieldCheck,
} from "lucide-react";
import { api, errorText, json } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { ErrorState, Loading } from "../../components/common";
import { toast } from "sonner";
import { Dialog } from "../../components/ui/dialog";
type ModelInfo = {
  configured?: boolean;
  model?: string;
  model_name?: string;
  base_url?: string;
  dimension?: number;
  status?: string;
  message?: string;
  tool_calling?: boolean;
  needs_rebuild?: boolean;
};
type Models = {
  llm?: ModelInfo;
  embedding?: ModelInfo;
  tool_calling?: { supported?: boolean; message?: string };
  [key: string]: unknown;
};
export function Settings({ kbId }: { kbId: string }) {
  const status = useQuery({
    queryKey: ["models"],
    queryFn: () => api<Models>("/settings/model-status"),
  });
  const [testResult, setTestResult] = useState<Record<string, unknown> | null>(
    null,
  );
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const rebuild = useMutation({
    mutationFn: () =>
      api("/settings/rebuild-embeddings", json("POST", { kb_id: kbId })),
    onSuccess: () => {
      setConfirmRebuild(false);
      toast.success("重建任务已加入队列");
      void status.refetch();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const test = useMutation({
    mutationFn: () =>
      api<Record<string, unknown>>("/settings/test-models", json("POST")),
    onSuccess: (data) => {
      setTestResult(data);
      void status.refetch();
    },
    onError: (e) => toast.error(errorText(e)),
  });
  return (
    <div className="page-scroll settings-page">
      <div className="eyebrow">
        <Settings2 size={15} />
        工作空间设置
      </div>
      <h1>让知识与模型连接</h1>
      <p className="page-lead">
        聊天与向量服务独立配置。密钥保存在后端环境中，不会发送到浏览器。
      </p>
      {status.isPending ? (
        <Loading />
      ) : status.isError ? (
        <ErrorState error={status.error} retry={() => void status.refetch()} />
      ) : (
        <div className="settings-grid">
          {(["llm", "embedding"] as const).map((key) => {
            const info = status.data?.[key];
            return (
              <section className="settings-card" key={key}>
                <div className="row spread">
                  <h3>{key === "llm" ? "聊天模型" : "Embedding 模型"}</h3>
                  <span
                    className={`status ${info?.configured ? "status-ready" : ""}`}
                  >
                    {info?.configured ? "已配置" : "需要配置"}
                  </span>
                </div>
                <dl>
                  <dt>模型</dt>
                  <dd>{info?.model || info?.model_name || "尚未设置"}</dd>
                  <dt>服务地址</dt>
                  <dd>{info?.base_url || "由后端 .env 设置"}</dd>
                  {key === "embedding" && (
                    <>
                      <dt>向量维度</dt>
                      <dd>{info?.dimension || "由实际返回向量校验"}</dd>
                    </>
                  )}
                </dl>
                {info?.needs_rebuild && (
                  <p className="notice warning">
                    模型发生变化，需要重建向量索引。
                  </p>
                )}
                {info?.message && <p className="muted">{info.message}</p>}
              </section>
            );
          })}
        </div>
      )}
      <div className="row gap">
        <Button
          variant="default"
          disabled={test.isPending}
          onClick={() => test.mutate()}
        >
          <RefreshCw size={15} className={test.isPending ? "spin" : ""} />
          {test.isPending ? "连接测试中…" : "测试聊天、向量与工具调用"}
        </Button>
        <Button
          disabled={
            !kbId || rebuild.isPending || !status.data?.embedding?.configured
          }
          onClick={() => setConfirmRebuild(true)}
        >
          重建当前库向量索引
        </Button>
      </div>
      <p className="notice">
        <ShieldCheck size={17} />
        {status.data?.tool_calling?.supported
          ? "模型已声明支持工具调用，可使用智能整理。"
          : status.data?.tool_calling?.message ||
            "工具调用尚未验证；请运行连接测试。知识库问答与智能整理的能力会分别检测。"}
      </p>
      {testResult && (
        <section className="settings-card">
          <h3>
            <CheckCircle2 size={17} /> 实际连接测试结果
          </h3>
          {Object.entries(testResult).map(([key, value]) => {
            const result = value as {
              ok?: boolean;
              message?: string;
              supported?: boolean;
            };
            return (
              <div className="model-test-row" key={key}>
                <div className="row spread">
                  <strong>
                    {{
                      llm: "聊天连接",
                      embedding: "向量连接",
                      tool_calling: "工具调用",
                    }[key] || key}
                  </strong>
                  <span
                    className={`status ${result.ok ? "status-ready" : "status-failed"}`}
                  >
                    {result.ok ? "通过" : "未通过"}
                  </span>
                </div>
                <p className="muted">
                  {result.message || (result.ok ? "服务正常" : "服务暂不可用")}
                </p>
              </div>
            );
          })}
        </section>
      )}
      <section className="settings-card">
        <h3>
          <KeyRound size={17} />
          填写后端环境变量
        </h3>
        <p className="muted">
          在项目根目录复制 .env.example 为 .env，分别填写下列参数，随后重启 api
          与 worker。
        </p>
        <pre className="config-example">
          LLM_BASE_URL=你的兼容服务地址 /v1{`\n`}LLM_API_KEY=你的聊天密钥{`\n`}
          LLM_MODEL=聊天模型名称{`\n\n`}EMBEDDING_BASE_URL=向量服务地址 /v1
          {`\n`}EMBEDDING_API_KEY=你的向量密钥{`\n`}EMBEDDING_MODEL=向量模型名称
          {`\n`}EMBEDDING_DIMENSION=实际向量维度
        </pre>
      </section>
      <p className="notice">
        <ShieldCheck size={17} />
        未配置模型时，文件上传、阅读、文件夹、标签和关键词搜索仍然可用。AI
        功能不会返回模拟结果。
      </p>
      <Dialog
        open={confirmRebuild}
        onOpenChange={setConfirmRebuild}
        title="重建向量索引"
        description="将使用当前 Embedding 模型为当前知识库重新向量化。此操作可能产生模型费用，正文和手动分类会保留。"
      >
        <div className="dialog-actions">
          <Button onClick={() => setConfirmRebuild(false)}>取消</Button>
          <Button
            variant="default"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            确认重建
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
