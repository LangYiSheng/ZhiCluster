import { useEffect, useMemo, useRef, useState } from "react";
import { RefreshCw } from "lucide-react";
import { api, errorText, json } from "../../lib/api";
import type {
  ConnectionConfig,
  ConnectionDraft,
  ModelCatalog,
  ModelScope,
} from "../../lib/settings";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { Checkbox } from "../../components/ui/checkbox";

type CatalogState = {
  identity: object;
  status: "loading" | "success" | "error";
  models: { id: string }[];
  message?: string;
};
const normalizeUrl = (value: string) => value.trim().replace(/\/+$/, "");

function validUrl(value: string) {
  try {
    const url = new URL(value);
    return (
      ["http:", "https:"].includes(url.protocol) &&
      !url.username &&
      !url.password &&
      !/[?#\s]/.test(value)
    );
  } catch {
    return false;
  }
}

export function ModelPicker({
  scope,
  connection,
  saved,
  revision,
  manual,
  onManualChange,
  onChange,
  enabledModels,
  onEnabledModelsChange,
}: {
  scope: ModelScope;
  connection: ConnectionDraft;
  saved: ConnectionConfig;
  revision: number;
  manual: boolean;
  onManualChange: (manual: boolean) => void;
  onChange: (value: string) => void;
  enabledModels?: string[];
  onEnabledModelsChange?: (models: string[]) => void;
}) {
  const baseUrl = connection.base_url.trim();
  const apiKey = connection.api_key || "";
  const clearKey = !!connection.clear_api_key;
  const savedKeyAvailable =
    saved.api_key_configured &&
    normalizeUrl(baseUrl) === normalizeUrl(saved.base_url);
  const eligible =
    validUrl(baseUrl) && !clearKey && (!!apiKey.trim() || savedKeyAvailable);
  // This token stays in component memory. Keys are never query keys or DOM data.
  const identity = useMemo(
    () => ({ baseUrl, apiKey, clearKey, revision, savedKeyAvailable }),
    [baseUrl, apiKey, clearKey, revision, savedKeyAvailable],
  );
  const [state, setState] = useState<CatalogState | null>(null);
  const [refresh, setRefresh] = useState<{
    identity: object;
    version: number;
  } | null>(null);
  const controllerRef = useRef<AbortController | null>(null);
  const generation = useRef(0);
  const current = state?.identity === identity ? state : undefined;

  useEffect(() => {
    const requestGeneration = ++generation.current;
    const controller = new AbortController();
    controllerRef.current = controller;
    if (!eligible) return () => controller.abort();
    const timeout = window.setTimeout(
      async () => {
        setState({ identity, status: "loading", models: [] });
        const connectionDraft = {
          base_url: baseUrl,
          ...(apiKey ? { api_key: apiKey } : {}),
        };
        try {
          const result = await api<ModelCatalog>("/settings/models", {
            ...json("POST", {
              scope,
              draft: { [scope]: connectionDraft },
            }),
            signal: controller.signal,
          });
          if (
            controller.signal.aborted ||
            generation.current !== requestGeneration
          )
            return;
          setState({
            identity,
            status: "success",
            models: result.models,
            message: result.message,
          });
        } catch (error) {
          if (
            controller.signal.aborted ||
            generation.current !== requestGeneration
          )
            return;
          setState({
            identity,
            status: "error",
            models: [],
            message: errorText(error),
          });
        }
      },
      refresh?.identity === identity ? 0 : 800,
    );
    return () => {
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [scope, baseUrl, apiKey, eligible, identity, refresh]);

  const id = `setting-${scope}-model`;
  const models = current?.models || [];
  const options = models.map((model) => ({ value: model.id, label: model.id }));
  if (
    connection.model &&
    !models.some((model) => model.id === connection.model)
  )
    options.unshift({
      value: connection.model,
      label: `${connection.model}（当前填写）`,
    });
  let notice = "填写地址和密钥后自动获取，也可手动填写模型 ID。";
  if (clearKey) notice = "已选择清除密钥，取消后可获取模型列表。";
  else if (
    validUrl(baseUrl) &&
    saved.api_key_configured &&
    !savedKeyAvailable &&
    !apiKey.trim()
  )
    notice = "服务地址已改变，请填写对应密钥以获取模型列表。";
  else if (current?.status === "loading") notice = "正在获取模型列表…";
  else if (current?.status === "error")
    notice = `${current.message} 可重试或手动填写模型 ID。`;
  else if (current?.status === "success")
    notice = models.length
      ? `已获取 ${models.length} 个模型，请按用途选择。`
      : current.message || "服务未返回可选模型，可手动填写模型 ID。";
  else if (eligible) notice = "将自动获取模型列表。";

  return (
    <div className="zc-setting-field zc-model-picker">
      <div className="zc-model-picker-heading">
        <label htmlFor={id}>模型名称</label>
        <div>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onManualChange(!manual)}
          >
            {manual ? "从列表选择" : "手动填写"}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            aria-label={`刷新${scope === "llm" ? "聊天" : "向量"}模型列表`}
            title="获取模型列表"
            disabled={!eligible || current?.status === "loading"}
            onClick={() => {
              controllerRef.current?.abort();
              generation.current++;
              setRefresh((value) => ({
                identity,
                version: (value?.version || 0) + 1,
              }));
            }}
          >
            <RefreshCw
              size={14}
              className={current?.status === "loading" ? "spin" : ""}
            />
          </Button>
        </div>
      </div>
      {manual ? (
        <input
          id={id}
          value={connection.model}
          maxLength={512}
          placeholder={
            scope === "llm" ? "例如 chat-model" : "例如 embedding-model"
          }
          spellCheck={false}
          aria-describedby={`${id}-help`}
          onChange={(event) => onChange(event.target.value)}
        />
      ) : (
        <Select
          id={id}
          value={connection.model}
          onValueChange={onChange}
          options={options}
          disabled={!options.length}
          placeholder={
            current?.status === "loading" ? "正在获取…" : "请选择模型"
          }
          aria-describedby={`${id}-help`}
        />
      )}
      <p id={`${id}-help`} className="zc-field-help" role="status">
        {notice}
      </p>
      {scope === "llm" && !!models.length && onEnabledModelsChange && (
        <fieldset className="zc-catalog-models">
          <legend>从服务目录启用聊天模型</legend>
          <div>
            {models.map((model) => (
              <label className="zc-checkbox" key={model.id}>
                <Checkbox
                  checked={enabledModels?.includes(model.id) || false}
                  disabled={
                    model.id === connection.model ||
                    ((enabledModels?.length || 0) >= 100 &&
                      !enabledModels?.includes(model.id))
                  }
                  onChange={(event) =>
                    onEnabledModelsChange(
                      event.target.checked
                        ? [...new Set([...(enabledModels || []), model.id])]
                        : (enabledModels || []).filter((id) => id !== model.id),
                    )
                  }
                />
                <span>{model.id}</span>
              </label>
            ))}
          </div>
        </fieldset>
      )}
    </div>
  );
}
