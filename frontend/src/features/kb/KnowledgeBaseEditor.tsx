import { useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";
import {
  Atom,
  BookOpen,
  Coffee,
  FolderClosed,
  Leaf,
  Mountain,
  Music2,
  Sparkles,
} from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { api, errorText, json } from "../../lib/api";
import type { KnowledgeBase } from "../../lib/api";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Select } from "../../components/ui/select";
import { ColorPicker } from "../../components/ui/color-picker";

const icons = {
  folder: FolderClosed,
  book: BookOpen,
  leaf: Leaf,
  coffee: Coffee,
  music: Music2,
  mountain: Mountain,
  sparkles: Sparkles,
  atom: Atom,
};
const iconNames: Record<string, string> = {
  folder: "文件夹",
  book: "书籍",
  leaf: "绿叶",
  coffee: "咖啡",
  music: "音乐",
  mountain: "山峰",
  sparkles: "星光",
  atom: "科学",
};
const colors = [
  "#55a995",
  "#4b8bd8",
  "#8d72c1",
  "#cf8498",
  "#bc925c",
  "#62934e",
  "#73828f",
  "#dd795e",
];
export function KnowledgeBaseIcon({
  kb,
  size = "small",
}: {
  kb: Pick<KnowledgeBase, "icon" | "color">;
  size?: "small" | "large";
}) {
  const Icon =
    icons[(kb.icon || "folder") as keyof typeof icons] || FolderClosed;
  return (
    <span
      className={`knowledge-base-icon knowledge-base-icon-${size}`}
      style={{ "--kb-color": kb.color || colors[0] } as CSSProperties}
      aria-hidden="true"
    >
      <Icon
        size={size === "large" ? 38 : 17}
        strokeWidth={size === "large" ? 1.5 : 1.8}
      />
    </span>
  );
}

type EditDraft = {
  name: string;
  description: string;
  icon: string;
  color: string;
  embedding_model: string;
  embedding_dimension: string;
};
type EmbeddingConfig = {
  revision: number;
  embedding: { model: string; dimension: number };
};
export function KnowledgeBaseEditor({
  open,
  onOpenChange,
  knowledgeBase,
  onSaved,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  knowledgeBase?: KnowledgeBase;
  onSaved?: (kb: KnowledgeBase) => void;
}) {
  const client = useQueryClient();
  const [draft, setDraft] = useState<EditDraft>({
    name: "",
    description: "",
    icon: "folder",
    color: colors[0],
    embedding_model: "",
    embedding_dimension: "",
  });
  const [catalog, setCatalog] = useState<string[]>([]);
  const [catalogError, setCatalogError] = useState("");
  const [manual, setManual] = useState(false);
  const generation = useRef(0);
  const incomingSnapshot = useRef(knowledgeBase);
  incomingSnapshot.current = knowledgeBase;
  const [snapshot, setSnapshot] = useState(knowledgeBase);
  const current = useRef({ open, id: knowledgeBase?.id });
  current.current = { open, id: knowledgeBase?.id };
  useEffect(() => {
    generation.current++;
    if (open) {
      const knowledgeBase = incomingSnapshot.current;
      setSnapshot(knowledgeBase);
      setDraft({
        name: knowledgeBase?.name || "",
        description: knowledgeBase?.description || "",
        icon: knowledgeBase?.icon || "folder",
        color: knowledgeBase?.color || colors[0],
        embedding_model: knowledgeBase?.embedding_model || "",
        embedding_dimension: knowledgeBase?.embedding_dimension
          ? String(knowledgeBase.embedding_dimension)
          : "",
      });
      setCatalog([]);
      setCatalogError("");
      setManual(false);
    }
  }, [open, knowledgeBase?.id]);
  const config = useQuery({
    queryKey: ["settings-config"],
    queryFn: () => api<EmbeddingConfig>("/settings/config"),
    enabled: open,
  });
  const fetchModels = useMutation({
    mutationFn: async (requestGeneration: number) => ({
      generation: requestGeneration,
      result: await api<{ models: { id: string }[] }>(
        "/settings/models",
        json("POST", { scope: "embedding" }),
      ),
    }),
    onSuccess: (result) => {
      if (current.current.open && result.generation === generation.current) {
        setCatalog(result.result.models.map((model) => model.id));
        setCatalogError("");
      }
    },
    onError: (error, requestGeneration) => {
      if (current.current.open && requestGeneration === generation.current) {
        setCatalogError(errorText(error));
        setManual(true);
      }
    },
  });
  const save = useMutation({
    mutationFn: async (request: {
      draft: EditDraft;
      id?: string;
      version?: number;
      generation: number;
    }) => ({
      request,
      entity: await api<KnowledgeBase>(
        request.id ? `/knowledge-bases/${request.id}` : "/knowledge-bases",
        json(request.id ? "PATCH" : "POST", {
          ...request.draft,
          name: request.draft.name.trim(),
          embedding_model: request.draft.embedding_model.trim() || null,
          embedding_dimension: request.draft.embedding_model.trim()
            ? Number(request.draft.embedding_dimension)
            : null,
          version: request.version,
        }),
      ),
    }),
    onSuccess: async ({ entity, request }) => {
      await client.invalidateQueries({ queryKey: ["knowledge-bases"] });
      if (
        current.current.open &&
        generation.current === request.generation &&
        current.current.id === request.id
      ) {
        onOpenChange(false);
        onSaved?.(entity);
      }
      toast.success("知识库已保存");
    },
    onError: (error) => toast.error(errorText(error)),
  });
  const update = (change: Partial<EditDraft>) =>
    setDraft((value) => ({ ...value, ...change }));
  const modelOptions = [
    ...new Set([draft.embedding_model, ...catalog].filter(Boolean)),
  ];
  return (
    <Dialog
      open={open}
      onOpenChange={onOpenChange}
      title={`${knowledgeBase ? "编辑" : "新建"}知识库`}
    >
      <form
        className="kb-editor"
        onSubmit={(event) => {
          event.preventDefault();
          save.mutate({
            draft,
            id: knowledgeBase?.id,
            version: snapshot?.version,
            generation: generation.current,
          });
        }}
      >
        <div className="kb-editor-identity">
          <KnowledgeBaseIcon kb={draft} size="large" />
          <label>
            名称
            <input
              autoFocus
              required
              maxLength={160}
              value={draft.name}
              onChange={(event) => update({ name: event.target.value })}
            />
          </label>
        </div>
        <label>
          描述
          <textarea
            maxLength={4000}
            rows={2}
            value={draft.description}
            onChange={(event) => update({ description: event.target.value })}
            placeholder="这个知识库收集什么资料？"
          />
        </label>
        <fieldset>
          <legend>图标</legend>
          <div className="kb-icon-options">
            {Object.keys(icons).map((icon) => (
              <button
                type="button"
                key={icon}
                className={draft.icon === icon ? "selected" : ""}
                aria-label={`${iconNames[icon]}图标`}
                aria-pressed={draft.icon === icon}
                onClick={() => update({ icon })}
              >
                <KnowledgeBaseIcon kb={{ icon, color: draft.color }} />
              </button>
            ))}
          </div>
        </fieldset>
        <fieldset>
          <legend>颜色</legend>
          <div className="kb-color-options">
            {colors.map((color) => (
              <button
                type="button"
                key={color}
                aria-label={`颜色 ${color}`}
                aria-pressed={draft.color === color}
                style={{ background: color }}
                onClick={() => update({ color })}
              />
            ))}
            <ColorPicker
              label="自定义知识库颜色"
              value={draft.color}
              selected={!colors.includes(draft.color)}
              onChange={(color) => update({ color })}
            />
          </div>
        </fieldset>
        <fieldset className="kb-embedding">
          <legend>嵌入模型</legend>
          <p className="muted tiny">
            每个知识库使用一个嵌入模型，负责为资料建立向量索引。
          </p>
          {manual ? (
            <label>
              模型 ID
              <input
                aria-label="知识库嵌入模型"
                maxLength={512}
                value={draft.embedding_model}
                placeholder={
                  config.data?.embedding?.model || "留空使用默认模型"
                }
                onChange={(event) =>
                  update({ embedding_model: event.target.value })
                }
              />
            </label>
          ) : (
            <Select
              aria-label="知识库嵌入模型"
              value={draft.embedding_model}
              onValueChange={(value) => update({ embedding_model: value })}
              options={[
                {
                  value: "",
                  label: `使用默认${config.data?.embedding?.model ? ` · ${config.data.embedding.model}` : "模型"}`,
                },
                ...modelOptions.map((value) => ({ value, label: value })),
              ]}
            />
          )}
          <div className="row gap">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => fetchModels.mutate(generation.current)}
              disabled={fetchModels.isPending}
            >
              {fetchModels.isPending ? "获取中…" : "获取可用模型"}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => setManual((value) => !value)}
            >
              {manual ? "从列表选择" : "手动填写"}
            </Button>
          </div>
          {!!draft.embedding_model && (
            <label>
              向量维度
              <input
                type="number"
                min={1}
                max={16000}
                required
                value={draft.embedding_dimension}
                placeholder={
                  config.data?.embedding?.dimension
                    ? `例如 ${config.data.embedding.dimension}，以模型实际维度为准`
                    : "填写此模型实际返回的维度"
                }
                onChange={(event) =>
                  update({ embedding_dimension: event.target.value })
                }
              />
            </label>
          )}
          {catalogError && (
            <p className="notice warning">
              {catalogError}，可手动填写模型 ID。
            </p>
          )}
          {snapshot &&
            (draft.embedding_model !== (snapshot.embedding_model || "") ||
              Number(draft.embedding_dimension || 0) !==
                (snapshot.embedding_dimension || 0)) && (
              <p className="notice warning">
                更换后需要在设置的索引维护中重建此知识库的向量索引。
              </p>
            )}
        </fieldset>
        <div className="dialog-actions">
          <Button type="button" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            variant="default"
            disabled={save.isPending || !draft.name.trim()}
          >
            {save.isPending ? "保存中…" : "保存"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
