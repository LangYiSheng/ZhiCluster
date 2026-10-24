import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowUp, MessageSquare, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { api, errorText, json } from "../../lib/api";
import type {
  Citation,
  Conversation,
  Folder,
  KnowledgeBase,
  Message,
  Tag,
} from "../../lib/api";
import { useSessionDraft } from "../../lib/useSessionDraft";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { ErrorState, Loading } from "../../components/common";
import { ConversationHistory } from "./ConversationHistory";
import { ScopeSelector } from "./ScopeSelector";
import { ChatProgress } from "./ChatProgress";
import { CitationList, MessageContent } from "./MessageContent";
import { useChatStream } from "./useChatStream";
import { isMessageBusy } from "./chatEvents";
import { scopeSummary } from "./scopeSummary";
import "./chat-ui.css";
const ignoreHistoryChange = () => {};
export function Chat({
  kb,
  knowledgeBases,
  tags,
  folders,
  onCitation,
  active = true,
  historyOpen = false,
  historyAnchor,
  onHistoryOpenChange = ignoreHistoryChange,
}: {
  kb: KnowledgeBase;
  knowledgeBases: KnowledgeBase[];
  tags: Tag[];
  folders: Folder[];
  onCitation: (citation: Citation) => void;
  active?: boolean;
  historyOpen?: boolean;
  historyAnchor?: HTMLElement | null;
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
  const [retrievalMode, setRetrievalMode] = useState<"direct" | "model">(
    "direct",
  );
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
    refetchInterval: 15000,
  });
  const displayedMessages = useChatStream(conversationId, messages.data || []);
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
  const selectedScopeLabel =
    conversationId && !persistedScope
      ? "正在读取对话范围"
      : scopeSummary({
          knowledgeBases,
          folders,
          tags,
          kbIds: selectedKbIds,
          folderIds: selectedFolderIds,
          tagIds: selectedTagIds,
          includeDescendants: selectedIncludeDescendants,
        });
  useEffect(() => {
    localStorage.setItem(`conversation:${kb.id}`, conversationId);
  }, [conversationId, kb.id]);
  const send = useMutation({
    mutationFn: async () => {
      const submittedText = text;
      let id = conversationId;
      if (!id) {
        const c = await api<Conversation>(
          "/conversations",
          json("POST", {
            title: submittedText.slice(0, 40) || "新对话",
            scope: draftScope,
          }),
        );
        id = c.id;
      }
      const message = await api<Message>(
        `/conversations/${id}/messages`,
        json("POST", { content: submittedText, retrieval_mode: retrievalMode }),
      );
      return { message, conversationId: id, draftKey, submittedText };
    },
    onSuccess: (result) => {
      clearDraft(result.draftKey, result.submittedText);
      setConversationId(result.conversationId);
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
  const busy = send.isPending || displayedMessages.some(isMessageBusy);
  const isEmpty =
    !displayedMessages.length &&
    !messages.isError &&
    !(messages.isPending && conversationId);
  return (
    <div className={`chat-container ${isEmpty ? "chat-is-empty" : ""}`}>
      <ConversationHistory
        open={active && historyOpen}
        onOpenChange={onHistoryOpenChange}
        anchorElement={historyAnchor}
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
        ) : messages.isPending &&
          conversationId &&
          !displayedMessages.length ? (
          <Loading />
        ) : !displayedMessages.length ? (
          <div className="chat-welcome">
            <div className="welcome-symbol">
              <Sparkles size={28} />
            </div>
            <h1>让知识产生连接</h1>
            <p>从你的文档出发，寻找答案、发现线索。</p>
          </div>
        ) : (
          displayedMessages.map((m) => (
            <article className={`message message-${m.role}`} key={m.id}>
              <div className="message-avatar">
                {m.role === "user" ? "我" : <Sparkles size={16} />}
              </div>
              <div className="message-body">
                <strong>{m.role === "user" ? "你" : "知簇"}</strong>
                {m.role === "assistant" && <ChatProgress message={m} />}
                <MessageContent
                  content={m.content}
                  citations={m.citations}
                  onCitation={onCitation}
                />
                {m.error && <p className="notice warning">{m.error}</p>}
                {m.role === "assistant" && (
                  <CitationList
                    content={m.content}
                    citations={m.citations}
                    onCitation={onCitation}
                  />
                )}
              </div>
            </article>
          ))
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
            <small className="composer-scope-label" title={selectedScopeLabel}>
              <MessageSquare size={13} />
              <span>{selectedScopeLabel}</span>
            </small>
            <label
              className="retrieval-mode-control"
              title="开启后，模型会规划搜索问题，并在需要时补充查找。"
            >
              <input
                type="checkbox"
                role="switch"
                aria-label="主动检索"
                checked={retrievalMode === "model"}
                disabled={busy}
                onChange={(event) =>
                  setRetrievalMode(event.target.checked ? "model" : "direct")
                }
              />
              <span>主动检索</span>
            </label>
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
          <span className="composer-shortcuts">
            Enter 发送 · Shift + Enter 换行 ·{" "}
          </span>
          <span>AI 回答请结合来源核实</span>
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
