import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { Button } from "../../components/ui/button";
import { api, errorText, json } from "../../lib/api";
import type { ReviewSuggestion } from "./api";

export function SuggestionRefresh({ item }: { item: ReviewSuggestion }) {
  const client = useQueryClient();
  const mutation = useMutation({
    mutationFn: () =>
      api<{ job_id: string; status: string }>(
        `/review/suggestions/${item.suggestion_id || item.id}/refresh`,
        json("POST", { document_version: item.current_version }),
      ),
    onSuccess: () =>
      client.invalidateQueries({ queryKey: ["review", "suggestions"] }),
  });
  const status =
    mutation.data && mutation.data.job_id !== item.refresh_job_id
      ? mutation.data.status
      : item.refresh_status;
  const running =
    mutation.isPending ||
    ["queued", "running", "retry_wait"].includes(status || "");
  return (
    <div className="review-suggestion-refresh">
      <Button
        size="sm"
        variant="ghost"
        disabled={running || item.can_edit === false}
        onClick={() => mutation.mutate()}
        aria-label={`重新生成建议：${item.document_name}`}
      >
        {running ? (
          <Loader2 size={13} className="spin" />
        ) : (
          <RefreshCw size={13} />
        )}
        {running ? "后台重新生成中…" : "重新生成建议"}
      </Button>
      {mutation.isError && (
        <p className="review-row-warning" role="alert">
          {errorText(mutation.error)}
        </p>
      )}
      {!running && item.refresh_error && (
        <p className="review-row-warning" role="alert">
          {item.refresh_error}
        </p>
      )}
    </div>
  );
}
