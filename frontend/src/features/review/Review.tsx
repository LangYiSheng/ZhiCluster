import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Sparkles, X } from "lucide-react";
import { Button } from "../../components/ui/button";
import { Select } from "../../components/ui/select";
import type { KnowledgeBase } from "../../lib/api";
import { CreatePlan } from "./CreatePlan";
import { Suggestions } from "./Suggestions";
import { Plans } from "./Plans";
import "./review.css";

export function Review({
  knowledgeBases,
  currentKbId,
}: {
  knowledgeBases: KnowledgeBase[];
  currentKbId: string;
}) {
  const [params, setParams] = useSearchParams();
  const [creating, setCreating] = useState(false);
  const tab = params.get("tab") === "plans" ? "plans" : "suggestions";
  const kbId = params.get("filter_kb") || "";
  const documentId = params.get("document") || undefined;
  const runId = params.get("run") || "";
  function update(values: Record<string, string | null>) {
    setParams((previous) => {
      const next = new URLSearchParams(previous);
      for (const [key, value] of Object.entries(values)) {
        if (value) next.set(key, value);
        else next.delete(key);
      }
      return next;
    });
  }
  return (
    <div className="review-page">
      <header className="review-heading">
        <div>
          <h1>整理审阅</h1>
          <p>统一审阅入库建议和整理方案，确认后再应用。</p>
        </div>
        <Button
          variant="default"
          disabled={!knowledgeBases.length}
          onClick={() => setCreating(true)}
        >
          <Sparkles size={15} />
          自动整理现有文档
        </Button>
      </header>
      <div className="review-toolbar">
        <nav className="review-tabs" aria-label="审阅类型">
          <button
            type="button"
            aria-current={tab === "suggestions" ? "page" : undefined}
            onClick={() => update({ tab: "suggestions", run: null })}
          >
            入库建议
          </button>
          <button
            type="button"
            aria-current={tab === "plans" ? "page" : undefined}
            onClick={() => update({ tab: "plans", document: null })}
          >
            整理方案
          </button>
        </nav>
        <Select
          size="sm"
          aria-label="筛选审阅知识库"
          value={kbId}
          onValueChange={(value) =>
            update({ filter_kb: value || null, run: null, document: null })
          }
          options={[
            { value: "", label: "全部知识库" },
            ...knowledgeBases.map((kb) => ({ value: kb.id, label: kb.name })),
          ]}
        />
      </div>
      {documentId && tab === "suggestions" && (
        <div className="review-document-filter">
          当前仅查看此文档的建议
          <Button
            size="icon"
            variant="ghost"
            aria-label="查看全部文档建议"
            onClick={() => update({ document: null })}
          >
            <X size={13} />
          </Button>
        </div>
      )}
      <div className="review-content">
        <section hidden={tab !== "suggestions"} aria-label="入库分类建议">
          <Suggestions
            key={`${kbId}:${documentId || ""}`}
            kbId={kbId}
            documentId={documentId}
            onShowPlan={(id) =>
              update({ tab: "plans", run: id, document: null })
            }
          />
        </section>
        <section hidden={tab !== "plans"} aria-label="整理方案审阅">
          <Plans
            key={kbId}
            kbId={kbId}
            knowledgeBases={knowledgeBases}
            selectedRunId={runId}
            onSelectRun={(id) => update({ run: id })}
          />
        </section>
      </div>
      {creating && (
        <CreatePlan
          knowledgeBases={knowledgeBases}
          initialKbId={kbId || currentKbId}
          onClose={() => setCreating(false)}
          onCreated={(run) => {
            setCreating(false);
            update({
              tab: "plans",
              run: run.id,
              filter_kb: run.kb_id,
              document: null,
            });
          }}
        />
      )}
    </div>
  );
}
