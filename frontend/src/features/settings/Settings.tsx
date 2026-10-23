import { useEffect, useRef, useState } from "react";
import { useBlocker, useLocation, useSearchParams } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Database,
  Palette,
  Plug,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { api, ApiError, errorText, json } from "../../lib/api";
import type { KnowledgeBase } from "../../lib/api";
import { configDraft, rangeRules } from "../../lib/settings";
import type {
  ModelStatus,
  ModelScope,
  ProbeResult,
  ProbeScope,
  RuntimeConfig,
  RuntimeDraft,
} from "../../lib/settings";
import type { Appearance } from "../../lib/appearance";
import { useUI } from "../../stores/ui";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import { Dialog } from "../../components/ui/dialog";
import { ErrorState, Loading } from "../../components/common";
import {
  AppearanceForm,
  ConnectionForm,
  Field,
  ProcessingForm,
  SettingsSection,
} from "./SettingsFields";
import "./settings.css";

type Section = "appearance" | "models" | "processing" | "maintenance";
const sections = [
  {
    id: "appearance",
    label: "外观与布局",
    icon: Palette,
    description: "调整配色、字体与阅读字号。",
  },
  {
    id: "models",
    label: "模型连接",
    icon: Plug,
    description: "配置聊天与向量服务。",
  },
  {
    id: "processing",
    label: "知识处理",
    icon: SlidersHorizontal,
    description: "管理文档切块与模型处理预算。",
  },
  {
    id: "maintenance",
    label: "索引维护",
    icon: Database,
    description: "查看向量配置，重建知识库索引。",
  },
] as const;
const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
const fieldId = (group: string, key: string) => `setting-${group}-${key}`;
type ProbeState = {
  busy: boolean;
  result?: ProbeResult;
  error?: string;
  fingerprint: number;
};

export function Settings({ kbId }: { kbId: string }) {
  const config = useQuery({
    queryKey: ["settings-config"],
    queryFn: () => api<RuntimeConfig>("/settings/config"),
    refetchOnWindowFocus: false,
  });
  if (config.isPending) return <Loading />;
  if (!config.data)
    return (
      <ErrorState error={config.error} retry={() => void config.refetch()} />
    );
  return <SettingsEditor initialConfig={config.data} kbId={kbId} />;
}

function SettingsEditor({
  initialConfig,
  kbId,
}: {
  initialConfig: RuntimeConfig;
  kbId: string;
}) {
  const ui = useUI();
  const [params] = useSearchParams();
  const location = useLocation();
  const requestedSection = params.get("section");
  const currentAppearance: Appearance = {
    theme: ui.theme,
    palette: ui.palette,
    fontPairing: ui.fontPairing,
    readingScale: ui.readingScale,
  };
  const [appearance, setAppearance] = useState<Appearance>(currentAppearance);
  const [savedAppearance, setSavedAppearance] =
    useState<Appearance>(currentAppearance);
  const [loaded, setLoaded] = useState(initialConfig);
  const [draft, setDraft] = useState<RuntimeDraft>(() =>
    configDraft(initialConfig),
  );
  const [section, setSection] = useState<Section>(
    () =>
      sections.find((item) => item.id === requestedSection)?.id || "appearance",
  );
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState("");
  const [saveError, setSaveError] = useState("");
  const [conflict, setConflict] = useState(false);
  const [reloading, setReloading] = useState(false);
  const [confirmReload, setConfirmReload] = useState(false);
  const [confirmRebuild, setConfirmRebuild] = useState(false);
  const [maintenanceKb, setMaintenanceKb] = useState(kbId);
  const [rebuildNotice, setRebuildNotice] = useState("");
  const [probes, setProbes] = useState<Partial<Record<ProbeScope, ProbeState>>>(
    {},
  );
  const [draftVersions, setDraftVersions] = useState({ llm: 0, embedding: 0 });
  const [manualModels, setManualModels] = useState<Record<ModelScope, boolean>>(
    {
      llm: false,
      embedding: false,
    },
  );
  const focusTarget = useRef("");
  const client = useQueryClient();
  const status = useQuery({
    queryKey: ["models"],
    queryFn: () => api<ModelStatus>("/settings/model-status"),
  });
  const bases = useQuery({
    queryKey: ["knowledge-bases"],
    queryFn: () => api<KnowledgeBase[]>("/knowledge-bases"),
  });
  const runtimeDirty = !equal(draft, configDraft(loaded));
  const dirty = runtimeDirty || !equal(appearance, savedAppearance);
  const blocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      dirty && currentLocation.pathname !== nextLocation.pathname,
  );
  const embeddingChanged =
    loaded.embedding.base_url !== draft.embedding.base_url ||
    loaded.embedding.model !== draft.embedding.model ||
    loaded.embedding.dimension !== draft.embedding.dimension;

  useEffect(() => {
    const target = sections.find((item) => item.id === requestedSection);
    if (target) setSection(target.id);
  }, [requestedSection, location.key]);

  useEffect(() => {
    if (initialConfig.revision !== loaded.revision && !runtimeDirty) {
      setLoaded(initialConfig);
      setDraft(configDraft(initialConfig));
      setDraftVersions((previous) => ({
        llm: previous.llm + 1,
        embedding: previous.embedding + 1,
      }));
    }
  }, [initialConfig, loaded.revision, runtimeDirty]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
        event.returnValue = "";
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);
  useEffect(() => {
    if (!dirty && blocker.state === "blocked") blocker.reset();
  }, [dirty, blocker]);
  useEffect(() => {
    if (!focusTarget.current) return;
    const target = document.getElementById(focusTarget.current);
    const details = target?.closest("details");
    if (details) details.open = true;
    target?.focus();
    focusTarget.current = "";
  }, [errors, section]);

  function change(
    group: keyof RuntimeDraft,
    key: string,
    value: string | number | boolean,
  ) {
    setDraft((previous) => {
      const fields = { ...previous[group], [key]: value };
      if (
        (key === "api_key" && value === "") ||
        (key === "clear_api_key" && !value)
      )
        delete fields[key as keyof typeof fields];
      return { ...previous, [group]: fields };
    });
    if (group !== "processing")
      setDraftVersions((previous) => ({
        ...previous,
        [group]: previous[group] + 1,
      }));
    setErrors((previous) => {
      const next = { ...previous };
      delete next[fieldId(group, key)];
      return next;
    });
    setMessage("");
  }
  function validate(scope?: ProbeScope) {
    const next: Record<string, string> = {};
    const groups =
      scope === "embedding"
        ? (["embedding"] as const)
        : scope
          ? (["llm"] as const)
          : (["llm", "embedding", "processing"] as const);
    for (const group of groups) {
      for (const [key, value] of Object.entries(draft[group])) {
        const range = rangeRules[key as keyof typeof rangeRules];
        if (
          range &&
          (!Number.isFinite(Number(value)) ||
            (key !== "timeout_seconds" && !Number.isInteger(value)) ||
            Number(value) < range[0] ||
            Number(value) > range[1])
        )
          next[fieldId(group, key)] =
            `请输入 ${range[0]} 至 ${range[1]} 之间的${key === "timeout_seconds" ? "数字" : "整数"}。`;
      }
      if (group !== "processing" && draft[group].base_url.trim()) {
        try {
          const url = new URL(draft[group].base_url);
          if (
            !["http:", "https:"].includes(url.protocol) ||
            url.username ||
            url.password ||
            url.search ||
            url.hash ||
            draft[group].base_url.includes("?") ||
            draft[group].base_url.includes("#") ||
            /\s/.test(draft[group].base_url.trim())
          )
            throw new Error();
        } catch {
          next[fieldId(group, "base_url")] =
            "请输入 HTTP 或 HTTPS 地址，不含用户名、密码、查询参数或锚点。";
        }
      }
    }
    if (
      !scope &&
      draft.processing.chunk_overlap_tokens >=
        draft.processing.chunk_size_tokens
    )
      next[fieldId("processing", "chunk_overlap_tokens")] =
        "重叠长度必须小于切块长度。";
    setErrors(next);
    const first = Object.keys(next)[0];
    if (first) {
      focusTarget.current = first;
      if (first.includes("processing") || first.includes("batch_size"))
        setSection("processing");
      else setSection("models");
      return false;
    }
    return true;
  }
  function payload(): RuntimeDraft {
    const clean = structuredClone(draft);
    for (const group of ["llm", "embedding"] as const) {
      clean[group].base_url = clean[group].base_url.trim();
      clean[group].model = clean[group].model.trim();
      if (!clean[group].api_key) delete clean[group].api_key;
      if (!clean[group].clear_api_key) delete clean[group].clear_api_key;
    }
    return clean;
  }
  const save = useMutation({
    mutationFn: async () =>
      runtimeDirty
        ? api<RuntimeConfig>(
            "/settings/config",
            json("PUT", { revision: loaded.revision, ...payload() }),
          )
        : loaded,
    onSuccess: (config) => {
      setLoaded(config);
      setDraft(configDraft(config));
      client.setQueryData(["settings-config"], config);
      ui.setAppearance(appearance);
      setSavedAppearance(appearance);
      setMessage("设置已保存。");
      setSaveError("");
      setConflict(false);
      setErrors({});
      void status.refetch();
    },
    onError: (error) => {
      setConflict(error instanceof ApiError && error.status === 409);
      setSaveError(
        error instanceof ApiError && error.status === 409
          ? "设置已在其他窗口更新。你的草稿已保留，请重新读取最新配置后再修改。"
          : errorText(error),
      );
    },
  });
  async function reload() {
    setConfirmReload(false);
    setReloading(true);
    setSaveError("");
    try {
      const config = await api<RuntimeConfig>("/settings/config");
      setLoaded(config);
      setDraft(configDraft(config));
      client.setQueryData(["settings-config"], config);
      setAppearance(currentAppearance);
      setSavedAppearance(currentAppearance);
      setDraftVersions((previous) => ({
        llm: previous.llm + 1,
        embedding: previous.embedding + 1,
      }));
      setErrors({});
      setConflict(false);
      setMessage("已重新读取最新设置。");
    } catch (error) {
      setSaveError(errorText(error));
    } finally {
      setReloading(false);
    }
  }
  async function probe(scope: ProbeScope) {
    if (!validate(scope)) return;
    const clean = payload();
    const probeDraft =
      scope === "embedding"
        ? { embedding: clean.embedding }
        : { llm: clean.llm };
    const fingerprint =
      draftVersions[scope === "embedding" ? "embedding" : "llm"];
    setProbes((previous) => ({
      ...previous,
      [scope]: { busy: true, fingerprint },
    }));
    try {
      const result = await api<Partial<Record<ProbeScope, ProbeResult>>>(
        "/settings/test-models",
        json("POST", { scope, draft: probeDraft }),
      );
      setProbes((previous) => ({
        ...previous,
        [scope]: { busy: false, result: result[scope], fingerprint },
      }));
    } catch (error) {
      setProbes((previous) => ({
        ...previous,
        [scope]: { busy: false, error: errorText(error), fingerprint },
      }));
    }
  }
  const rebuild = useMutation({
    mutationFn: () =>
      api(
        "/settings/rebuild-embeddings",
        json("POST", { kb_id: maintenanceKb }),
      ),
    onSuccess: () => {
      setConfirmRebuild(false);
      setRebuildNotice("重建任务已加入队列，可在知识库文件列表查看处理进度。");
      void status.refetch();
    },
    onError: (error) => setRebuildNotice(errorText(error)),
  });
  function probeButton(scope: ProbeScope, label: string) {
    const state = probes[scope];
    const fingerprint =
      draftVersions[scope === "embedding" ? "embedding" : "llm"];
    return (
      <div className="zc-probe">
        <Button
          type="button"
          disabled={state?.busy || save.isPending}
          onClick={() => void probe(scope)}
        >
          <RefreshCw size={15} className={state?.busy ? "spin" : ""} />
          {state?.busy ? "正在测试…" : label}
        </Button>
        {(state?.result || state?.error) && (
          <div
            className={`zc-probe-result ${state.result?.ok ? "is-success" : "is-error"}`}
            role="status"
          >
            <strong>{state.result?.ok ? "测试通过" : "测试未通过"}</strong>
            <span>{state.error || state.result?.message}</span>
            {state.result?.elapsed_ms !== undefined && (
              <small>耗时 {state.result.elapsed_ms} ms</small>
            )}
            <small>
              {state.fingerprint === fingerprint
                ? "当前草稿的测试结果。"
                : "配置已修改，此结果对应先前的草稿，请重新测试。"}
            </small>
          </div>
        )}
      </div>
    );
  }
  const activeSection = sections.find((item) => item.id === section)!;
  const selectedBase = bases.data?.find((base) => base.id === maintenanceKb);
  return (
    <div className="zc-settings-page">
      <nav className="zc-settings-nav" aria-label="设置分类">
        <span className="zc-settings-nav-title">偏好与连接</span>
        {sections.map(({ id, label, icon: Icon }) => (
          <button
            type="button"
            key={id}
            aria-current={section === id ? "page" : undefined}
            onClick={() => setSection(id)}
          >
            <Icon size={17} />
            <span>{label}</span>
          </button>
        ))}
      </nav>
      <div className="zc-settings-workspace">
        <header className="zc-settings-header">
          <div>
            <h1>{activeSection.label}</h1>
            <p>{activeSection.description}</p>
          </div>
        </header>
        <form
          className="zc-settings-form"
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            if (validate()) {
              setMessage("");
              setSaveError("");
              save.mutate();
            }
          }}
        >
          <fieldset
            className="zc-settings-content"
            disabled={save.isPending || reloading}
          >
            {saveError && (
              <div className="zc-settings-error" role="alert">
                {saveError}
                {conflict && (
                  <Button type="button" onClick={() => setConfirmReload(true)}>
                    重新读取最新设置
                  </Button>
                )}
              </div>
            )}
            {message && (
              <p className="zc-settings-success" role="status">
                <Check size={16} />
                {message}
              </p>
            )}
            {section === "appearance" && (
              <AppearanceForm
                appearance={appearance}
                onChange={(value) => {
                  setAppearance(value);
                  setMessage("");
                }}
              />
            )}
            {section === "models" && (
              <ConnectionForm
                draft={draft}
                loaded={loaded}
                errors={errors}
                change={change}
                embeddingChanged={embeddingChanged}
                probeButton={probeButton}
                manualModels={manualModels}
                onManualModelChange={(group, manual) =>
                  setManualModels((previous) => ({
                    ...previous,
                    [group]: manual,
                  }))
                }
              />
            )}
            {section === "processing" && (
              <ProcessingForm draft={draft} errors={errors} change={change} />
            )}
            {section === "maintenance" && (
              <SettingsSection
                title="向量索引"
                description="重建时使用已保存的向量配置。"
              >
                <Field id="maintenance-kb" label="要维护的知识库">
                  <Select
                    id="maintenance-kb"
                    value={maintenanceKb}
                    onValueChange={(value) => {
                      setMaintenanceKb(value);
                      setRebuildNotice("");
                    }}
                    options={[
                      { value: "", label: "请选择知识库" },
                      ...(bases.data || []).map((base) => ({
                        value: base.id,
                        label: `${base.name}${base.id === kbId ? "（当前库）" : ""}`,
                      })),
                    ]}
                  />
                </Field>
                {bases.isError && (
                  <ErrorState
                    error={bases.error}
                    retry={() => void bases.refetch()}
                  />
                )}
                <dl className="zc-maintenance-status">
                  <div>
                    <dt>目标知识库</dt>
                    <dd>{selectedBase?.name || "尚未选择"}</dd>
                  </div>
                  <div>
                    <dt>已保存的向量模型</dt>
                    <dd>{loaded.embedding.model || "尚未设置"}</dd>
                  </div>
                  <div>
                    <dt>向量维度</dt>
                    <dd>{loaded.embedding.dimension}</dd>
                  </div>
                  <div>
                    <dt>配置状态</dt>
                    <dd>
                      {status.data?.embedding?.configured
                        ? "已配置"
                        : "尚未就绪"}
                    </dd>
                  </div>
                </dl>
                {status.isError && (
                  <ErrorState
                    error={status.error}
                    retry={() => void status.refetch()}
                  />
                )}
                {status.data?.embedding?.needs_rebuild && (
                  <p className="zc-settings-warning">
                    向量配置已变化，已有索引需要重建。
                  </p>
                )}
                {runtimeDirty && (
                  <p className="zc-settings-warning">
                    存在尚未保存的配置，请先保存后再重建。
                  </p>
                )}
                <Button
                  type="button"
                  disabled={
                    !selectedBase ||
                    rebuild.isPending ||
                    runtimeDirty ||
                    !status.data?.embedding?.configured
                  }
                  onClick={() => {
                    setRebuildNotice("");
                    setConfirmRebuild(true);
                  }}
                >
                  <RefreshCw
                    size={15}
                    className={rebuild.isPending ? "spin" : ""}
                  />
                  {rebuild.isPending ? "正在提交…" : "重建所选知识库向量索引"}
                </Button>
                {rebuildNotice && (
                  <p className="zc-settings-note" role="status">
                    {rebuildNotice}
                  </p>
                )}
                <p className="zc-settings-note">
                  重建可能产生模型费用，正文和手动分类会保留。
                </p>
              </SettingsSection>
            )}
          </fieldset>
          <footer className="zc-settings-footer">
            <span role="status" className={dirty ? "is-dirty" : ""}>
              {save.isPending
                ? "正在保存…"
                : dirty
                  ? "有未保存的修改"
                  : message
                    ? "修改已保存"
                    : "所有设置已是最新"}
            </span>
            <div>
              <Button
                type="button"
                variant="ghost"
                disabled={save.isPending || reloading}
                onClick={() => (dirty ? setConfirmReload(true) : void reload())}
              >
                {reloading ? "正在读取…" : "重新读取"}
              </Button>
              <Button
                type="submit"
                variant="default"
                disabled={!dirty || save.isPending || reloading || conflict}
              >
                保存修改
              </Button>
            </div>
          </footer>
        </form>
      </div>
      <Dialog
        open={confirmReload}
        onOpenChange={setConfirmReload}
        title="重新读取设置？"
        description="这会放弃尚未保存的修改和新填写的密钥，读取服务器上的最新设置。"
      >
        <div className="dialog-actions">
          <Button onClick={() => setConfirmReload(false)}>继续编辑</Button>
          <Button variant="default" onClick={() => void reload()}>
            放弃草稿并重新读取
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={confirmRebuild}
        onOpenChange={setConfirmRebuild}
        title="确认重建向量索引"
        description={`将使用已保存的 ${loaded.embedding.model || "向量模型"} 为「${selectedBase?.name || "所选知识库"}」重新向量化。此操作可能产生模型费用，正文和手动分类会保留。`}
      >
        <div className="dialog-actions">
          <Button
            disabled={rebuild.isPending}
            onClick={() => setConfirmRebuild(false)}
          >
            取消
          </Button>
          <Button
            variant="default"
            disabled={rebuild.isPending}
            onClick={() => rebuild.mutate()}
          >
            {rebuild.isPending ? "正在提交…" : "确认费用并重建"}
          </Button>
        </div>
      </Dialog>
      <Dialog
        open={blocker.state === "blocked"}
        onOpenChange={(open) => {
          if (!open) blocker.reset?.();
        }}
        title="放弃未保存的修改？"
        description={
          save.isPending || reloading
            ? "正在保存或读取设置，请等待完成。"
            : "离开设置会丢失草稿和新填写的密钥。"
        }
      >
        <div className="dialog-actions">
          <Button onClick={() => blocker.reset?.()}>继续编辑</Button>
          <Button
            variant="default"
            disabled={save.isPending || reloading}
            onClick={() => blocker.proceed?.()}
          >
            放弃修改并离开
          </Button>
        </div>
      </Dialog>
    </div>
  );
}
