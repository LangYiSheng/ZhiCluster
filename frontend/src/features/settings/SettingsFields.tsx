import { useId, type ReactNode } from "react";
import type { Appearance } from "../../lib/appearance";
import { PALETTES, FONT_PAIRINGS } from "../../lib/appearance";
import type {
  ProbeScope,
  RuntimeConfig,
  RuntimeDraft,
} from "../../lib/settings";
import { rangeRules } from "../../lib/settings";
import { Checkbox } from "../../components/ui/checkbox";
import { Radio } from "../../components/ui/radio";
import { Select } from "../../components/ui/select";

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

export function SettingsSection({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  const id = useId();
  return (
    <section className="zc-settings-section" aria-labelledby={id}>
      <header className="zc-settings-section-heading">
        <h2 id={id}>{title}</h2>
        {description && <p>{description}</p>}
      </header>
      {children}
    </section>
  );
}

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
      {children}
      {help && (
        <p id={`${id}-help`} className="zc-field-help">
          {help}
        </p>
      )}
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
  const id = fieldId(group, field);
  const range = rangeRules[field];
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
    <div className="zc-settings-sections">
      <SettingsSection title="显示与配色">
        <Field id="appearance-theme" label="显示模式">
          <Select
            id="appearance-theme"
            value={appearance.theme}
            onValueChange={(value) =>
              onChange({
                ...appearance,
                theme: value as Appearance["theme"],
              })
            }
            options={[
              { value: "light", label: "浅色" },
              { value: "dark", label: "深色" },
              { value: "system", label: "跟随系统" },
            ]}
          />
        </Field>
        <fieldset className="zc-choice-field">
          <legend>配色</legend>
          <div className="zc-palette-choices">
            {PALETTES.map((item) => (
              <label
                className={`zc-palette-choice ${appearance.palette === item.id ? "is-selected" : ""}`}
                key={item.id}
              >
                <Radio
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
      </SettingsSection>
      <SettingsSection title="文字与阅读">
        <div className="zc-settings-grid">
          <Field id="appearance-font" label="字体搭配">
            <Select
              id="appearance-font"
              value={appearance.fontPairing}
              onValueChange={(value) =>
                onChange({
                  ...appearance,
                  fontPairing: value as Appearance["fontPairing"],
                })
              }
              options={FONT_PAIRINGS.map((item) => ({
                value: item.id,
                label: item.name,
              }))}
            />
          </Field>
          <Field
            id="appearance-scale"
            label="阅读字号"
            help="应用于文档与对话正文。"
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
        </div>
        <div
          className={`zc-appearance-preview zc-preview-${appearance.palette} zc-preview-${appearance.theme}`}
          data-font={appearance.fontPairing}
          style={{ fontSize: `${16 * appearance.readingScale}px` }}
          aria-label="外观效果预览"
        >
          <span>阅读预览</span>
          <h3>我的知识笔记</h3>
          <p>在这里查看文档与对话正文的字体、配色和字号效果。</p>
        </div>
      </SettingsSection>
    </div>
  );
}

export function ConnectionForm({
  draft,
  loaded,
  errors,
  change,
  embeddingChanged,
  probeButton,
}: FormProps & {
  loaded: RuntimeConfig;
  embeddingChanged: boolean;
  probeButton: (scope: ProbeScope, label: string) => ReactNode;
}) {
  const props = { draft, errors, change };
  return (
    <div className="zc-settings-sections">
      <p className="zc-field-help">
        使用兼容 OpenAI 的接口，系统会自动追加 /chat/completions 或
        /embeddings。
      </p>
      {(["llm", "embedding"] as const).map((group) => {
        const connection = draft[group];
        const configured = loaded[group].api_key_configured;
        return (
          <SettingsSection
            key={group}
            title={group === "llm" ? "聊天模型" : "向量模型"}
            description={
              group === "llm"
                ? "用于知识问答与内容摘要。"
                : "用于文档向量化与语义检索。"
            }
          >
            <div className="zc-settings-grid">
              <Field
                id={fieldId(group, "base_url")}
                label="服务地址"
                help="填写接口前缀，例如 https://api.example.com/v1。"
                error={errors[fieldId(group, "base_url")]}
              >
                <input
                  id={fieldId(group, "base_url")}
                  type="url"
                  maxLength={2048}
                  value={connection.base_url}
                  autoComplete="url"
                  placeholder="https://api.example.com/v1"
                  spellCheck={false}
                  aria-invalid={!!errors[fieldId(group, "base_url")]}
                  aria-describedby={`${fieldId(group, "base_url")}-help${errors[fieldId(group, "base_url")] ? ` ${fieldId(group, "base_url")}-error` : ""}`}
                  onChange={(event) =>
                    change(group, "base_url", event.target.value)
                  }
                />
              </Field>
              <Field
                id={fieldId(group, "model")}
                label="模型名称"
                help="填写服务方提供的模型 ID。"
              >
                <input
                  id={fieldId(group, "model")}
                  value={connection.model}
                  maxLength={512}
                  placeholder={
                    group === "llm" ? "例如 chat-model" : "例如 embedding-model"
                  }
                  spellCheck={false}
                  onChange={(event) =>
                    change(group, "model", event.target.value)
                  }
                />
              </Field>
              <Field
                id={fieldId(group, "api_key")}
                label="API 密钥"
                help={
                  configured
                    ? "已配置。留空保留原密钥，填写新值后替换。"
                    : "无认证的本地服务可填写占位值，如 local。"
                }
              >
                <input
                  id={fieldId(group, "api_key")}
                  type="password"
                  maxLength={4096}
                  value={connection.api_key || ""}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={configured ? "保留已保存的密钥" : "填写服务密钥"}
                  disabled={connection.clear_api_key}
                  aria-describedby={`${fieldId(group, "api_key")}-help`}
                  onChange={(event) =>
                    change(group, "api_key", event.target.value)
                  }
                />
                {configured && (
                  <label className="zc-checkbox">
                    <Checkbox
                      checked={!!connection.clear_api_key}
                      onChange={(event) => {
                        change(group, "clear_api_key", event.target.checked);
                        if (event.target.checked) change(group, "api_key", "");
                      }}
                    />
                    保存时清除现有密钥
                  </label>
                )}
              </Field>
              {group === "embedding" && (
                <NumberField
                  {...props}
                  group="embedding"
                  field="dimension"
                  label="向量维度"
                  help="与服务输出一致，范围 1–16000。更改后需重建索引。"
                />
              )}
            </div>
            <details className="zc-settings-advanced">
              <summary>高级连接选项</summary>
              <div className="zc-settings-grid">
                <NumberField
                  {...props}
                  group={group}
                  field="timeout_seconds"
                  label="请求超时（秒）"
                  help="单次请求的最长等待时间，范围 1–600 秒。"
                />
                <NumberField
                  {...props}
                  group={group}
                  field="max_retries"
                  label="失败重试次数"
                  help="网络错误后的重试上限，范围 0–4 次。"
                />
              </div>
              {group === "llm" && (
                <Field
                  id="setting-llm-supports_tools"
                  label="工具调用"
                  help="服务是否支持兼容的工具调用，可单独测试。"
                >
                  <label className="zc-checkbox">
                    <Checkbox
                      id="setting-llm-supports_tools"
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
            {embeddingChanged && group === "embedding" && (
              <p className="zc-settings-warning">
                保存后需重建已有索引，新文档会使用新配置。
              </p>
            )}
            <div className="zc-probe-actions">
              {probeButton(
                group,
                group === "llm" ? "测试聊天连接" : "测试向量连接",
              )}
              {group === "llm" && probeButton("tool_calling", "测试工具调用")}
            </div>
            <p className="zc-settings-note">
              测试使用当前草稿，可能产生少量费用；不会保存设置。
            </p>
          </SettingsSection>
        );
      })}
    </div>
  );
}

export function ProcessingForm(props: FormProps) {
  return (
    <div className="zc-settings-sections">
      <SettingsSection title="文档切块" description="应用于之后处理的文档。">
        <div className="zc-settings-grid">
          <NumberField
            {...props}
            group="processing"
            field="chunk_size_tokens"
            label="切块长度（Token）"
            help="每个检索片段的目标长度，范围 128–8192。"
          />
          <NumberField
            {...props}
            group="processing"
            field="chunk_overlap_tokens"
            label="切块重叠（Token）"
            help="相邻片段的上下文，范围 0–2048，须小于切块长度。"
          />
        </div>
      </SettingsSection>
      <SettingsSection title="摘要与向量预算">
        <div className="zc-settings-grid">
          <NumberField
            {...props}
            group="processing"
            field="summary_input_tokens"
            label="单次摘要输入上限（Token）"
            help="单次摘要读取的原文量，范围 1024–200000。"
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
            help="每批发送的片段数，范围 1–256，须符合服务限制。"
          />
        </div>
      </SettingsSection>
      <SettingsSection title="并发与重试">
        <div className="zc-settings-grid">
          <NumberField
            {...props}
            group="processing"
            field="max_concurrent_model_calls"
            label="模型并发请求上限"
            help="同时进行的模型调用数，范围 1–16。"
          />
          <NumberField
            {...props}
            group="processing"
            field="max_ingestion_attempts"
            label="文档处理尝试上限"
            help="失败任务的总尝试次数，范围 1–10。"
          />
        </div>
      </SettingsSection>
    </div>
  );
}
