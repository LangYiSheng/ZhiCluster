import {
  Check,
  MessageSquare,
  MoreHorizontal,
  Plus,
  Trash2,
} from "lucide-react";
import type { Conversation, KnowledgeBase } from "../../lib/api";
import { Empty, ErrorState, Loading } from "../../components/common";
import { Button } from "../../components/ui/button";
import { Dialog } from "../../components/ui/dialog";
import { Menu, MenuItem } from "../../components/ui/menu";

export function ConversationHistory({
  open,
  onOpenChange,
  conversations,
  currentId,
  knowledgeBases,
  loading,
  error,
  disabled,
  onRetry,
  onSelect,
  onRename,
  onDelete,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  conversations: Conversation[];
  currentId: string;
  knowledgeBases: KnowledgeBase[];
  loading: boolean;
  error: unknown;
  disabled: boolean;
  onRetry: () => void;
  onSelect: (id: string) => void;
  onRename: (conversation: Conversation) => void;
  onDelete: (id: string) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange} title="历史对话" wide>
      <div className="conversation-history">
        <div className="history-actions">
          <span className="muted">{conversations.length} 个对话</span>
          <Button disabled={disabled} onClick={() => onSelect("")}>
            <Plus size={16} />
            新建对话
          </Button>
        </div>
        {loading ? (
          <Loading />
        ) : error ? (
          <ErrorState error={error} retry={onRetry} />
        ) : !conversations.length ? (
          <Empty title="还没有历史对话" icon={<MessageSquare size={24} />}>
            开始提问后，对话会保存在这里。
          </Empty>
        ) : (
          <div className="history-list">
            {conversations.map((conversation) => {
              const selected = conversation.id === currentId;
              const kbIds = (conversation.scope?.kb_ids as string[]) || [];
              const scope = kbIds
                .map((id) => knowledgeBases.find((kb) => kb.id === id)?.name)
                .filter(Boolean)
                .join("、");
              const createdAt = conversation.created_at
                ? new Date(conversation.created_at)
                : null;
              return (
                <article
                  key={conversation.id}
                  className={`history-card ${selected ? "is-current" : ""}`}
                >
                  <button
                    className="history-card-select"
                    aria-label={`打开对话：${conversation.title}`}
                    aria-current={selected ? "true" : undefined}
                    disabled={disabled}
                    onClick={() => onSelect(conversation.id)}
                  >
                    <span className="history-card-heading">
                      <MessageSquare size={16} />
                      <strong>{conversation.title}</strong>
                      {selected && <Check size={15} aria-label="当前对话" />}
                    </span>
                    <span className="history-card-meta">
                      {scope && <span>{scope}</span>}
                      {createdAt && !Number.isNaN(createdAt.getTime()) && (
                        <time dateTime={conversation.created_at}>
                          {createdAt.toLocaleDateString("zh-CN", {
                            month: "short",
                            day: "numeric",
                          })}
                        </time>
                      )}
                    </span>
                  </button>
                  <Menu
                    trigger={
                      <Button
                        size="icon"
                        variant="ghost"
                        aria-label={`对话操作：${conversation.title}`}
                        disabled={disabled}
                      >
                        <MoreHorizontal size={17} />
                      </Button>
                    }
                  >
                    <MenuItem onSelect={() => onRename(conversation)}>
                      重命名
                    </MenuItem>
                    <MenuItem danger onSelect={() => onDelete(conversation.id)}>
                      <Trash2 size={14} />
                      删除对话
                    </MenuItem>
                  </Menu>
                </article>
              );
            })}
          </div>
        )}
      </div>
    </Dialog>
  );
}
