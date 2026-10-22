import type { ReactNode } from "react";
import { KeyRound } from "lucide-react";
import type { Appearance } from "../../lib/appearance";
import { PALETTES, FONT_PAIRINGS } from "../../lib/appearance";
import type {
  ProbeScope,
  RuntimeConfig,
  RuntimeDraft,
} from "../../lib/settings";

import { rangeRules } from "../../lib/settings";
const fieldId = (group: string, key: string) => `setting-${group}-${key}`;
type FormProps = {
  draft: RuntimeDraft;
  errors: Record<string, string>;
  change: (
    group: keyof RuntimeDraft,
    key: string,
    value: string | number | boolean,
  ) => void;
};

export function Field({
  id,
  label,
  help,
  error,
  children,
}: {
  id: string;
  label: string;
  help?: string;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="zc-setting-field">
      <label htmlFor={id}>{label}</label>
      {help && (
        <p id={`${id}-help`} className="zc-field-help">
          {help}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} className="zc-field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
function NumberField({
  group,
  field,
  label,
  help,
  draft,
  errors,
  change,
}: FormProps & {
  group: keyof RuntimeDraft;
  field: keyof typeof rangeRules;
  label: string;
  help: string;
}) {
  const id = fieldId(group, field),
    range = rangeRules[field];
  const value = Number(
    (draft[group] as unknown as Record<string, unknown>)[field],
  );
  return (
    <Field id={id} label={label} help={help} error={errors[id]}>
      <input
        id={id}
        type="number"
        min={range[0]}
        max={range[1]}
        step={field === "timeout_seconds" ? "any" : "1"}
        value={Number.isNaN(value) ? "" : value}
        aria-invalid={!!errors[id]}
        aria-describedby={`${id}-help${errors[id] ? ` ${id}-error` : ""}`}
        onChange={(event) =>
          change(
            group,
            field,
            event.target.value === "" ? NaN : Number(event.target.value),
          )
        }
      />
    </Field>
  );
}

export function AppearanceForm({
  appearance,
  onChange,
}: {
  appearance: Appearance;
  onChange: (appearance: Appearance) => void;
}) {
  return (
    <section className="zc-settings-section">
      <Field
        id="appearance-theme"
        label="显示模式"
        help="跟随系统会自动使用设备的浅色或深色外观。"
      >
        <select
          id="appearance-theme"
          value={appearance.theme}
          onChange={(event) =>
            onChange({
              ...appearance,
              theme: event.target.value as Appearance["theme"],
            })
          }
        >
          <option value="light">浅色</option>
          <option value="dark">深色</option>
          <option value="system">跟随系统</option>
        </select>
      </Field>
      <fieldset className="zc-choice-field">
        <legend>配色</legend>
        <p className="zc-field-help">保留柔和的背景与清晰的文字层次。</p>
        <div className="zc-palette-choices">
          {PALETTES.map((item) => (
            <label
              className={`zc-palette-choice ${appearance.palette === item.id ? "is-selected" : ""}`}
              key={item.id}
            >
              <input
                type="radio"
                name="palette"
                value={item.id}
                checked={appearance.palette === item.id}
                onChange={() => onChange({ ...appearance, palette: item.id })}
              />
              <span
                className={`zc-palette-swatch ${item.id}`}
                aria-hidden="true"
              >
                <i />
                <i />
                <i />
              </span>
              <strong>{item.name}</strong>
              <small>{item.id === "ink" ? "米白与暖黑" : "自然与清爽"}</small>
            </label>
          ))}
        </div>
      </fieldset>
      <Field
        id="appearance-font"
        label="字体搭配"
        help="标题与阅读字体会一起调整，界面操作始终保持清晰。"
      >
        <select
          id="appearance-font"
          value={appearance.fontPairing}
          onChange={(event) =>
            onChange({
              ...appearance,
              fontPairing: event.target.value as Appearance["fontPairing"],
            })
          }
        >
          {FONT_PAIRINGS.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
      </Field>
      <Field
        id="appearance-scale"
        label="阅读字号"
        help="调整文档与对话正文，菜单和按钮大小保持稳定。"
      >
        <div className="zc-scale-control">
          <input
            id="appearance-scale"
            type="range"
            min="0.9"
            max="1.2"
            step="0.05"
            value={appearance.readingScale}
            onChange={(event) =>
              onChange({
                ...appearance,
                readingScale: Number(event.target.value),
              })
            }
          />
          <output htmlFor="appearance-scale">
            {Math.round(appearance.readingScale * 100)}%
          </output>
        </div>
      </Field>
      <div
        className={`zc-appearance-preview zc-preview-${appearance.palette} zc-preview-${appearance.theme}`}
        data-font={appearance.fontPairing}
        style={{ fontSize: `${16 * appearance.readingScale}px` }}
        aria-label="外观效果预览"
      >
        <span>知识阅读 · 效果预览</span>
        <h3>把零散的知识，连成自己的答案。</h3>
        <p>每一条笔记都有来处，每一次提问都有依据。慢慢积累，也清晰生长。</p>
        <div>
          来自《我的知识笔记》 <span>查看原文 ↗</span>
        </div>
      </div>
      <p className="zc-settings-note">保存后应用到当前浏览器的整个工作台。</p>
    </section>
  );
}

export function ConnectionForm({
  draft,
  loaded,
  tab,
  setTab,
  errors,
  change,
  embeddingChanged,
  probeButton,
}: FormProps & {
  loaded: RuntimeConfig;
  tab: "llm" | "embedding";
  setTab: (tab: "llm" | "embedding") => void;
  embeddingChanged: boolean;
  probeButton: (scope: ProbeScope, label: string) => ReactNode;
}) {
  const connection = draft[tab],
    configured = loaded[tab].api_key_configured;
  const props = { draft, errors, change };
  return (
    <section className="zc-settings-section">
      <div className="zc-settings-tabs" role="tablist" aria-label="模型类型">
        {(["llm", "embedding"] as const).map((key) => (
          <button
            key={key}
            id={`model-tab-${key}`}
            type="button"
            role="tab"
            tabIndex={key === tab ? 0 : -1}
            aria-selected={tab === key}
            aria-controls="model-panel"
            onClick={() => setTab(key)}
            onKeyDown={(event) => {
              if (
                ["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              ) {
                event.preventDefault();
                const next =
                  event.key === "Home"
                    ? "llm"
                    : event.key === "End"
                      ? "embedding"
                      : tab === "llm"
                        ? "embedding"
                        : "llm";
                setTab(next);
                document.getElementById(`model-tab-${next}`)?.focus();
              }
            }}
          >
            {key === "llm" ? "聊天模型" : "向量模型"}
          </button>
        ))}
      </div>
      <div
        id="model-panel"
        role="tabpanel"
        aria-labelledby={`model-tab-${tab}`}
        key={tab}
      >
        <p className="zc-settings-note">
          {tab === "llm"
            ? "用于知识问答、摘要和智能整理。"
            : "用于文档向量化和语义检索，服务必须返回固定维度的向量。"}
        </p>
        <Field
          id={fieldId(tab, "base_url")}
          label="服务地址"
          help="兼容服务的完整 Base URL，例如 https://api.example.com/v1。留空表示尚未配置。"
          error={errors[fieldId(tab, "base_url")]}
        >
          <input
            id={fieldId(tab, "base_url")}
            type="url"
            maxLength={2048}
            value={connection.base_url}
            autoComplete="url"
            placeholder="https://api.example.com/v1"
            spellCheck={false}
            aria-invalid={!!errors[fieldId(tab, "base_url")]}
            aria-describedby={`${fieldId(tab, "base_url")}-help`}
            onChange={(event) => change(tab, "base_url", event.target.value)}
          />
        </Field>
        <Field
          id={fieldId(tab, "model")}
          label="模型名称"
          help="填写服务提供方支持的准确模型 ID。"
        >
          <input
            id={fieldId(tab, "model")}
            value={connection.model}
            maxLength={512}
            placeholder={
              tab === "llm" ? "例如 chat-model" : "例如 embedding-model"
            }
            spellCheck={false}
            onChange={(event) => change(tab, "model", event.target.value)}
          />
        </Field>
        <Field
          id={fieldId(tab, "api_key")}
          label="API 密钥"
          help={
            configured
              ? "已保存密钥。输入框留空会保留现有密钥；填写新值会替换。"
              : "尚未保存密钥。无认证的本地服务请按其文档填写占位密钥。"
          }
        >
          <div className="zc-secret-state">
            <KeyRound size={14} />
            {configured ? "已配置密钥" : "未配置密钥"}
          </div>
          <input
            id={fieldId(tab, "api_key")}
            type="password"
            maxLength={4096}
            value={connection.api_key || ""}
            autoComplete="new-password"
            spellCheck={false}
            placeholder={configured ? "保留已保存的密钥" : "填写服务密钥"}
            disabled={connection.clear_api_key}
            aria-describedby={`${fieldId(tab, "api_key")}-help`}
            onChange={(event) => change(tab, "api_key", event.target.value)}
          />
          {configured && (
            <label className="zc-checkbox">
              <input
                type="checkbox"
                checked={!!connection.clear_api_key}
                onChange={(event) => {
                  change(tab, "clear_api_key", event.target.checked);
                  if (event.target.checked) change(tab, "api_key", "");
                }}
              />
              保存时清除现有密钥
            </label>
          )}
        </Field>
        {tab === "embedding" && (
          <NumberField
            {...props}
            group="embedding"
            field="dimension"
            label="向量维度"
            help="必须与服务实际输出一致；更换模型、地址或维度后，需要重建已有索引。范围 1–16000。"
          />
        )}
        <details className="zc-settings-advanced">
          <summary>高级连接选项</summary>
          <NumberField
            {...props}
            group={tab}
            field="timeout_seconds"
            label="请求超时（秒）"
            help="单次模型请求的最长等待时间，范围 1–600 秒。"
          />
          <NumberField
            {...props}
            group={tab}
            field="max_retries"
            label="失败重试次数"
            help="临时网络错误发生后的重试上限，范围 0–4 次。"
          />
          {tab === "llm" && (
            <Field
              id="setting-llm-supports_tools"
              label="工具调用"
              help="启用后允许智能整理调用模型工具；请单独测试实际兼容性。"
            >
              <label className="zc-checkbox">
                <input
                  id="setting-llm-supports_tools"
                  type="checkbox"
                  checked={draft.llm.supports_tools}
                  onChange={(event) =>
                    change("llm", "supports_tools", event.target.checked)
                  }
                />
                服务支持工具调用
              </label>
            </Field>
          )}
        </details>
        {embeddingChanged && tab === "embedding" && (
          <p className="zc-settings-warning">
            向量配置草稿已变化。保存后，已有文档需要使用新配置重建索引；新上传文档将使用新配置。
          </p>
        )}
        <div className="zc-probe-actions">
          {probeButton(tab, tab === "llm" ? "测试聊天连接" : "测试向量连接")}
          {tab === "llm" && probeButton("tool_calling", "测试工具调用")}
        </div>
        <p className="zc-settings-note">
          连接测试使用当前草稿，可能产生少量模型费用。测试通过与保存成功分别显示。
        </p>
      </div>
    </section>
  );
}

export function ProcessingForm(props: FormProps) {
  return (
    <section className="zc-settings-section">
      <h2>文档切块</h2>
      <NumberField
        {...props}
        group="processing"
        field="chunk_size_tokens"
        label="切块长度（Token）"
        help="每个检索片段的目标长度，范围 128–8192。更改后用于新处理的文档。"
      />
      <NumberField
        {...props}
        group="processing"
        field="chunk_overlap_tokens"
        label="切块重叠（Token）"
        help="相邻片段保留的上下文，范围 0–2048，且必须小于切块长度。"
      />
      <h2>摘要与向量预算</h2>
      <NumberField
        {...props}
        group="processing"
        field="summary_input_tokens"
        label="单次摘要输入上限（Token）"
        help="限制单次摘要读取的原文预算，范围 1024–200000。"
      />
      <NumberField
        {...props}
        group="processing"
        field="summary_max_calls"
        label="每篇文档摘要调用上限"
        help="控制长文档的摘要成本，范围 1–100 次。"
      />
      <NumberField
        {...props}
        group="embedding"
        field="batch_size"
        label="向量批处理大小"
        help="每批发送给向量服务的片段数，范围 1–256；请与服务限制保持一致。"
      />
      <details className="zc-settings-advanced">
        <summary>高级处理选项</summary>
        <NumberField
          {...props}
          group="processing"
          field="max_concurrent_model_calls"
          label="模型并发请求上限"
          help="同时进行的模型调用数，范围 1–16。较低值可减少服务限流。"
        />
        <NumberField
          {...props}
          group="processing"
          field="max_ingestion_attempts"
          label="文档处理尝试上限"
          help="失败任务的总尝试次数，范围 1–10。"
        />
      </details>
      <p className="zc-settings-note">
        保存后，API 的后续请求与 Worker
        新领取的任务会读取新配置，正在执行的任务沿用开始时的配置。
      </p>
    </section>
  );
}
