import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ArrowUp,
  BookOpen,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Sparkles,
  Trash2,
} from "lucide-react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { toast } from "sonner";
import { api, anchorText, errorText, json } from "../../lib/api";
import type {
  Citation,
  Conversation,
  Folder,
  KnowledgeBase,
  Message,
  Tag,
} from "../../lib/api";
import { useEvents } from "../../lib/events";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Menu, MenuItem } from "../../components/ui/menu";
import { ErrorState, Loading } from "../../components/common";
export function Chat({
  kb,
  knowledgeBases,
  tags,
  folders,
  onCitation,
}: {
  kb: KnowledgeBase;
  knowledgeBases: KnowledgeBase[];
  tags: Tag[];
  folders: Folder[];
  onCitation: (citation: Citation) => void;
}) {
  const qc = useQueryClient();
  const [conversationId, setConversationId] = useState(
    () => localStorage.getItem(`conversation:${kb.id}`) || "",
  );
  const [text, setText] = useState("");
  const [scopeIds, setScopeIds] = useState([kb.id]);
  const [scopeTags, setScopeTags] = useState<string[]>([]);
  const [scopeFolders, setScopeFolders] = useState<string[]>([]);
  const [includeDescendants, setIncludeDescendants] = useState(true);
  const [stream, setStream] = useState("");
  const [rename, setRename] = useState<Conversation | null>(null);
  const conversations = useQuery({
    queryKey: ["conversations"],
    queryFn: () => api<Conversation[]>("/conversations"),
  });
  const messages = useQuery({
    queryKey: ["messages", conversationId],
    queryFn: () => api<Message[]>(`/conversations/${conversationId}/messages`),
    enabled: !!conversationId,
    refetchInterval: 4000,
  });
  const persistedScope = conversations.data?.find(
    (c) => c.id === conversationId,
  )?.scope;
  const selectedKbIds = conversationId
    ? (persistedScope?.kb_ids as string[]) || []
    : scopeIds;
  const selectedTagIds = conversationId
    ? (persistedScope?.tag_ids as string[]) || []
    : scopeTags;
  const selectedFolderIds = conversationId
    ? (persistedScope?.folder_ids as string[]) || []
    : scopeFolders;
  const selectedIncludeDescendants = conversationId
    ? persistedScope?.include_descendants !== false
    : includeDescendants;
  const draftScope = {
    kb_ids: scopeIds,
    tag_ids: scopeTags,
    folder_ids: scopeFolders,
    include_descendants: includeDescendants,
  };
  useEffect(() => {
    localStorage.setItem(`conversation:${kb.id}`, conversationId);
    setStream("");
  }, [conversationId, kb.id]);
  const create = useMutation({
    mutationFn: () =>
      api<Conversation>(
        "/conversations",
        json("POST", {
          title: "新对话",
          scope: draftScope,
        }),
      ),
    onSuccess: (c) => {
      setConversationId(c.id);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const send = useMutation({
    mutationFn: async () => {
      let id = conversationId;
      if (!id) {
        const c = await api<Conversation>(
          "/conversations",
          json("POST", {
            title: text.slice(0, 40) || "新对话",
            scope: draftScope,
          }),
        );
        id = c.id;
        setConversationId(id);
      }
      return api<Message>(
        `/conversations/${id}/messages`,
        json("POST", { content: text }),
      );
    },
    onSuccess: () => {
      setText("");
      setStream("");
      void qc.invalidateQueries({ queryKey: ["messages"] });
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  const manage = useMutation({
    mutationFn: ({
      id,
      method,
      body,
    }: {
      id: string;
      method: string;
      body?: unknown;
    }) => api(`/conversations/${id}`, json(method, body)),
    onSuccess: () => {
      setRename(null);
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    },
    onError: (e) => toast.error(errorText(e)),
  });
  useEvents(
    conversationId ? `/conversations/${conversationId}/events` : null,
    (e) => {
      if (e.type === "token") {
        const token = e.data?.token || e.data?.content || e.data?.text;
        if (typeof token === "string") setStream((s) => s + token);
      }
      if (["completed", "error"].includes(e.type || "")) {
        setStream("");
        void qc.invalidateQueries({ queryKey: ["messages", conversationId] });
      }
    },
  );
  const busy =
    send.isPending ||
    messages.data?.some((m) =>
      ["queued", "running", "generating", "processing"].includes(
        m.status || "",
      ),
    );
  return (
    <div className="chat-container">
      <div className="conversation-toolbar">
        <select
          aria-label="切换对话"
          value={conversationId}
          onChange={(e) => setConversationId(e.target.value)}
        >
          <option value="">新的知识对话</option>
          {conversations.data?.map((c) => (
            <option key={c.id} value={c.id}>
              {c.title}
            </option>
          ))}
        </select>
        <Button
          size="icon"
          variant="ghost"
          aria-label="新建对话"
          disabled={create.isPending || !scopeIds.length}
          onClick={() => create.mutate()}
        >
          <Plus size={16} />
        </Button>
        {conversationId && (
          <Menu
            trigger={
              <Button size="icon" variant="ghost" aria-label="对话菜单">
                <MoreHorizontal size={16} />
              </Button>
            }
          >
            <MenuItem
              onSelect={() =>
                setRename(
                  conversations.data?.find((c) => c.id === conversationId) ||
                    null,
                )
              }
            >
              重命名对话
            </MenuItem>
            <MenuItem
              danger
              onSelect={() => {
                manage.mutate({ id: conversationId, method: "DELETE" });
                setConversationId("");
              }}
            >
              <Trash2 size={14} />
              删除对话
            </MenuItem>
          </Menu>
        )}
      </div>
      <div className="chat-messages">
        {messages.isError ? (
          <ErrorState
            error={messages.error}
            retry={() => void messages.refetch()}
          />
        ) : messages.isPending && conversationId ? (
          <Loading />
        ) : !messages.data?.length ? (
          <div className="chat-welcome">
            <div className="welcome-symbol">
              <Sparkles size={28} />
            </div>
            <span className="eyebrow">AI KNOWLEDGE WORKSPACE</span>
            <h1>让知识产生连接</h1>
            <p>
              从你的文档出发，寻找答案、发现线索。
              <br />
              每一个回答，都能追溯到真实来源。
            </p>
            <div className="welcome-scope">
              <BookOpen size={17} />
              <span>{conversationId ? "会话知识范围" : "当前知识库"}</span>
              <strong>
                {selectedKbIds
                  .map(
                    (id) =>
                      knowledgeBases.find((k) => k.id === id)?.name ||
                      "无权访问的知识库",
                  )
                  .join("、") || "正在读取范围"}
              </strong>
            </div>
            <p className="tiny muted">
              先上传资料，再提出你的问题。AI 需要在设置中连接模型服务。
            </p>
          </div>
        ) : (
          messages.data.map((m) => (
            <article className={`message message-${m.role}`} key={m.id}>
              <div className="message-avatar">
                {m.role === "user" ? "我" : <Sparkles size={16} />}
              </div>
              <div className="message-body">
                <strong>{m.role === "user" ? "你" : "知簇"}</strong>
                <div className="markdown">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
                    {m.content ||
                      (["queued", "running", "processing"].includes(
                        m.status || "",
                      )
                        ? "正在查阅知识库…"
                        : "")}
                  </ReactMarkdown>
                </div>
                {m.error && <p className="notice warning">{m.error}</p>}
                {!!m.citations?.length && (
                  <div className="citations">
                    <span className="tiny muted">真实来源</span>
                    {m.citations.map((c, i) => (
                      <button
                        key={c.chunk_id}
                        disabled={c.available === false}
                        title={
                          c.available === false
                            ? "来源已删除或无权访问"
                            : undefined
                        }
                        onClick={() => onCitation(c)}
                      >
                        <FileSource ordinal={c.ordinal || i + 1} />
                        <div>
                          <strong>
                            {c.document_name || c.display_name || "查看原文"}
                          </strong>
                          <small>
                            {c.available === false
                              ? "来源已删除或无权访问"
                              : anchorText(c)}
                          </small>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </div>
            </article>
          ))
        )}
        {stream && (
          <article className="message message-assistant">
            <div className="message-avatar">
              <Sparkles size={16} />
            </div>
            <div className="message-body">
              <strong>知簇</strong>
              <div className="markdown">
                <ReactMarkdown skipHtml remarkPlugins={[remarkGfm]}>
                  {stream}
                </ReactMarkdown>
              </div>
            </div>
          </article>
        )}
      </div>
      <div className="chat-composer-wrap">
        {
          <details className="scope-selector">
            <summary>
              <BookOpen size={13} />
              问答范围 · {selectedKbIds.length} 个知识库
              {selectedFolderIds.length
                ? ` · ${selectedFolderIds.length} 个文件夹`
                : ""}
              {selectedTagIds.length
                ? ` · ${selectedTagIds.length} 个标签`
                : ""}
            </summary>
            <div className="scope-options">
              {knowledgeBases
                .filter((k) => !k.deleted_at)
                .map((k) => (
                  <label className="checkbox-label" key={k.id}>
                    <input
                      type="checkbox"
                      disabled={!!conversationId}
                      checked={selectedKbIds.includes(k.id)}
                      onChange={(e) =>
                        setScopeIds((s) =>
                          e.target.checked
                            ? [...s, k.id]
                            : s.filter((id) => id !== k.id),
                        )
                      }
                    />
                    {k.name}
                  </label>
                ))}
              <div className="divider" />
              <div className="tiny muted">
                文件夹范围（当前库；勾选下方选项可包含子目录）
              </div>
              {folders
                .filter((f) => !f.deleted_at)
                .map((f) => (
                  <label className="checkbox-label" key={f.id}>
                    <input
                      type="checkbox"
                      disabled={!!conversationId}
                      checked={selectedFolderIds.includes(f.id)}
                      onChange={(e) =>
                        setScopeFolders((s) =>
                          e.target.checked
                            ? [...s, f.id]
                            : s.filter((id) => id !== f.id),
                        )
                      }
                    />
                    {f.name}
                  </label>
                ))}
              <label className="checkbox-label">
                <input
                  type="checkbox"
                  disabled={!!conversationId}
                  checked={selectedIncludeDescendants}
                  onChange={(e) => setIncludeDescendants(e.target.checked)}
                />
                包含所有子文件夹
              </label>
              {selectedFolderIds
                .filter((id) => !folders.some((f) => f.id === id))
                .map((id) => (
                  <p className="tiny muted" key={id}>
                    已保存的文件夹范围：{id}
                  </p>
                ))}
              <div className="divider" />
              <div className="tiny muted">标签范围：同时匹配全部选中标签</div>
              {tags.map((t) => (
                <label className="checkbox-label" key={t.id}>
                  <input
                    type="checkbox"
                    disabled={!!conversationId}
                    checked={selectedTagIds.includes(t.id)}
                    onChange={(e) =>
                      setScopeTags((s) =>
                        e.target.checked
                          ? [...s, t.id]
                          : s.filter((id) => id !== t.id),
                      )
                    }
                  />
                  {t.name}
                </label>
              ))}
              {!!conversationId && (
                <p className="tiny muted">
                  此范围保存在当前会话中。选择“新的知识对话”可重新设置。
                </p>
              )}
            </div>
          </details>
        }
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !busy) send.mutate();
          }}
        >
          <textarea
            aria-label="知识库问题"
            placeholder="向你的知识库提问…"
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (text.trim() && !busy) send.mutate();
              }
            }}
          />
          <div className="row spread">
            <small>
              <MessageSquare size={13} />
              基于你的知识库回答
            </small>
            <Button
              variant="default"
              size="icon"
              aria-label="发送问题"
              disabled={!text.trim() || busy || !scopeIds.length}
            >
              <ArrowUp size={18} />
            </Button>
          </div>
        </form>
        <p className="composer-note">
          Enter 发送 · Shift + Enter 换行 · AI 回答请结合来源核实
        </p>
      </div>
      <Dialog
        open={!!rename}
        onOpenChange={(v) => !v && setRename(null)}
        title="重命名对话"
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (rename)
              manage.mutate({
                id: rename.id,
                method: "PATCH",
                body: { title: rename.title },
              });
          }}
        >
          <label>
            名称
            <input
              required
              value={rename?.title || ""}
              onChange={(e) =>
                setRename((v) => (v ? { ...v, title: e.target.value } : null))
              }
            />
          </label>
          <div className="dialog-actions">
            <Button variant="default" disabled={manage.isPending}>
              保存
            </Button>
          </div>
        </form>
      </Dialog>
    </div>
  );
}
function FileSource({ ordinal }: { ordinal: number }) {
  return <span className="source-number">{ordinal}</span>;
}
