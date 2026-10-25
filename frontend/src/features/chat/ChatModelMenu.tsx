import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import { Brain, Check, ChevronDown, Plus, Zap } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Popover } from "../../components/ui/popover";
import { errorText } from "../../lib/api";

export function ChatModelMenu({
  models,
  model,
  mode,
  disabled,
  active,
  loading,
  error,
  kbId,
  onModelChange,
  onModeChange,
  onRetry,
}: {
  models: string[];
  model: string;
  mode: "direct" | "model";
  disabled: boolean;
  active: boolean;
  loading: boolean;
  error: unknown;
  kbId: string;
  onModelChange: (model: string) => void;
  onModeChange: (mode: "direct" | "model") => void;
  onRetry: () => void;
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  return (
    <Popover
      open={active && open}
      onOpenChange={setOpen}
      title="模型与思考模式"
      side="top"
      align="start"
      className="chat-model-popover"
      trigger={
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="chat-model-trigger"
          disabled={disabled}
          aria-label="选择模型与思考模式"
        >
          {mode === "model" ? <Brain size={14} /> : <Zap size={14} />}
          <span>{model || "默认模型"}</span>
          <small>{mode === "model" ? "思考" : "快速"}</small>
          <ChevronDown size={12} />
        </Button>
      }
    >
      <div className="chat-thinking-options" role="group" aria-label="思考模式">
        <button
          type="button"
          aria-pressed={mode === "direct"}
          disabled={disabled}
          onClick={() => onModeChange("direct")}
        >
          <Zap size={14} />
          快速
        </button>
        <button
          type="button"
          aria-pressed={mode === "model"}
          disabled={disabled}
          onClick={() => onModeChange("model")}
        >
          <Brain size={14} />
          思考
        </button>
      </div>
      <p className="chat-mode-hint">
        {mode === "direct"
          ? "先检索资料，再直接回答"
          : "由模型规划查阅，按需继续搜索"}
      </p>
      <div className="chat-model-list" role="group" aria-label="对话模型">
        {loading ? (
          <p className="muted">正在读取模型…</p>
        ) : error ? (
          <div role="alert">
            <p>{errorText(error)}</p>
            <Button type="button" size="sm" onClick={onRetry}>
              重试
            </Button>
          </div>
        ) : !models.length ? (
          <p className="muted">在设置中添加对话模型</p>
        ) : (
          models.map((id) => (
            <button
              type="button"
              key={id}
              aria-pressed={model === id}
              disabled={disabled}
              onClick={() => {
                onModelChange(id);
                setOpen(false);
              }}
            >
              <span>{id}</span>
              {model === id && <Check size={15} />}
            </button>
          ))
        )}
      </div>
      <Link
        className="chat-model-settings"
        to={`/settings?kb=${encodeURIComponent(kbId)}&section=models`}
      >
        <Plus size={15} />
        设置首选与自定义模型
      </Link>
    </Popover>
  );
}
