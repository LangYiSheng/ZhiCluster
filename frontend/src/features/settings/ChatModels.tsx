import { useState } from "react";
import { Check, Plus, X } from "lucide-react";
import { Button } from "../../components/ui/button";

export function ChatModels({
  models,
  defaultModel,
  onChange,
  onDefaultChange,
}: {
  models: string[];
  defaultModel: string;
  onChange: (models: string[]) => void;
  onDefaultChange: (model: string) => void;
}) {
  const [custom, setCustom] = useState("");
  const [error, setError] = useState("");
  const enabled = [
    ...new Set(
      [defaultModel, ...models].map((value) => value.trim()).filter(Boolean),
    ),
  ];
  function add() {
    const model = custom.trim();
    if (
      !model ||
      [...model].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      )
    ) {
      setError("请输入有效的模型 ID。");
      return;
    }
    if (enabled.length >= 100 && !enabled.includes(model)) {
      setError("最多启用 100 个聊天模型。");
      return;
    }
    onChange([...new Set([...enabled, model])]);
    if (!defaultModel) onDefaultChange(model);
    setCustom("");
    setError("");
  }
  return (
    <div className="zc-chat-models">
      <div className="zc-model-list-title">
        <strong>已启用的聊天模型</strong>
        <small>在对话输入区随时切换</small>
      </div>
      <div className="zc-enabled-models">
        {enabled.length ? (
          enabled.map((model) => (
            <div className="zc-enabled-model" key={model}>
              <span title={model}>{model}</span>
              <button
                type="button"
                className={model === defaultModel ? "is-default" : ""}
                aria-label={`设为默认模型 ${model}`}
                aria-pressed={model === defaultModel}
                onClick={() => onDefaultChange(model)}
              >
                {model === defaultModel && <Check size={13} />}
                {model === defaultModel ? "默认" : "设为默认"}
              </button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`移除聊天模型 ${model}`}
                disabled={model === defaultModel}
                onClick={() => onChange(enabled.filter((id) => id !== model))}
              >
                <X size={13} />
              </Button>
            </div>
          ))
        ) : (
          <p className="zc-field-help">
            从服务目录选择模型，或在下方添加模型 ID。
          </p>
        )}
      </div>
      <label htmlFor="custom-chat-model">添加自定义模型</label>
      <div className="zc-add-model">
        <input
          id="custom-chat-model"
          maxLength={512}
          placeholder="输入同一服务下的模型 ID"
          value={custom}
          onChange={(event) => {
            setCustom(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              add();
            }
          }}
        />
        <Button type="button" disabled={!custom.trim()} onClick={add}>
          <Plus size={14} />
          添加
        </Button>
      </div>
      {error && (
        <p role="alert" className="zc-field-error">
          {error}
        </p>
      )}
      <p className="zc-field-help">
        这些模型共用上面的服务地址与密钥；列表中的默认模型也用于摘要等后台任务。
      </p>
    </div>
  );
}
