import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, BookOpen, MessageSquare, Sparkles } from "lucide-react";
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
import { useSessionDraft } from "../../lib/useSessionDraft";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { ErrorState, Loading } from "../../components/common";
import { ConversationHistory } from "./ConversationHistory";
import { ScopeSelector } from "./ScopeSelector";
const ignoreHistoryChange = () => {};
export function Chat({
  kb,
  knowledgeBases,
  tags,
  folders,
  onCitation,
  active = true,
  historyOpen = false,
  onHistoryOpenChange = ignoreHistoryChange,
}: {
  kb: KnowledgeBase;
  knowledgeBases: KnowledgeBase[];
  tags: Tag[];
  folders: Folder[];
  onCitation: (citation: Citation) => void;
  active?: boolean;
  historyOpen?: boolean;
  onHistoryOpenChange?: (open: boolean) => void;
}) {
  const qc = useQueryClient();
  const [conversationId, setConversationId] = useState(
    () => localStorage.getItem(`conversation:${kb.id}`) || "",
  );
  const draftKey = `zhicluster:draft:v1:chat:${kb.id}:${conversationId || "new"}`;
  const [text, setText, clearDraft] = useSessionDraft(draftKey);
  const [scopeIds, setScopeIds] = useState([kb.id]);
  const [scopeTags, setScopeTags] = useState<string[]>([]);
  const [scopeFolders, setScopeFolders] = useState<string[]>([]);
  const [includeDescendants, setIncludeDescendants] = useState(true);
  const [stream, setStream] = useState("");
  const [rename, setRename] = useState<Conversation | null>(null);
  useEffect(() => {
    if (!active) {
      setRename(null);
      onHistoryOpenChange(false);
    }
  }, [active, onHistoryOpenChange]);
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
      }
      const message = await api<Message>(
        `/conversations/${id}/messages`,
        json("POST", { content: text }),
      );
      return { message, conversationId: id, draftKey };
    },
    onSuccess: (result) => {
      clearDraft(result.draftKey);
      setConversationId(result.conversationId);
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
    onSuccess: (_, variables) => {
      setRename(null);
      if (variables.method === "DELETE" && variables.id === conversationId)
        setConversationId("");
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
      <ConversationHistory
        open={active && historyOpen}
        onOpenChange={onHistoryOpenChange}
        conversations={conversations.data || []}
        currentId={conversationId}
        knowledgeBases={knowledgeBases}
        loading={conversations.isPending}
        error={conversations.isError ? conversations.error : null}
        disabled={send.isPending || manage.isPending}
        onRetry={() => void conversations.refetch()}
        onSelect={(id) => {
          setConversationId(id);
          onHistoryOpenChange(false);
        }}
        onRename={(conversation) => {
          onHistoryOpenChange(false);
          setRename(conversation);
        }}
        onDelete={(id) => manage.mutate({ id, method: "DELETE" })}
      />
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
        {active && (
          <ScopeSelector
            knowledgeBases={knowledgeBases}
            folders={folders}
            tags={tags}
            currentKb={kb}
            kbIds={selectedKbIds}
            folderIds={selectedFolderIds}
            tagIds={selectedTagIds}
            includeDescendants={selectedIncludeDescendants}
            readOnly={!!conversationId}
            disabled={send.isPending}
            onKbChange={(ids) => {
              setScopeIds(ids);
              if (!ids.includes(kb.id)) {
                setScopeFolders([]);
                setScopeTags([]);
              }
            }}
            onFoldersChange={setScopeFolders}
            onTagsChange={setScopeTags}
            onIncludeDescendantsChange={setIncludeDescendants}
          />
        )}
        <form
          className="chat-composer"
          onSubmit={(e) => {
            e.preventDefault();
            if (text.trim() && !busy && selectedKbIds.length) send.mutate();
          }}
        >
          <textarea
            aria-label="知识库问题"
            placeholder="向你的知识库提问…"
            value={text}
            disabled={send.isPending}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (
                e.key === "Enter" &&
                !e.shiftKey &&
                !e.nativeEvent.isComposing
              ) {
                e.preventDefault();
                if (text.trim() && !busy && selectedKbIds.length) send.mutate();
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
              disabled={!text.trim() || busy || !selectedKbIds.length}
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
        open={active && !!rename}
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
