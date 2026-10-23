import {
  FileText,
  ListChecks,
  ListTodo,
  MessageSquare,
  PanelLeftOpen,
  Settings2,
  Trash2,
} from "lucide-react";
import { Button } from "../components/ui/button";

const main = [
  { view: "chat", label: "知识对话", icon: MessageSquare },
  { view: "document", label: "文档管理", icon: FileText },
];
const tools = [
  { view: "review", label: "整理审阅", icon: ListChecks },
  { view: "tasks", label: "任务列表", icon: ListTodo },
  { view: "trash", label: "回收站", icon: Trash2 },
  { view: "settings", label: "设置", icon: Settings2 },
];

export function NavigationRail({
  view,
  onNavigate,
  onExpand,
  hidden,
  inert,
}: {
  view: string;
  onNavigate: (view: string) => void;
  onExpand: () => void;
  hidden: boolean;
  inert: boolean;
}) {
  const actions = (items: typeof main) =>
    items.map(({ view: destination, label, icon: Icon }) => (
      <Button
        key={destination}
        variant="ghost"
        size="icon"
        aria-label={label}
        title={label}
        aria-current={view === destination ? "page" : undefined}
        onClick={() => onNavigate(destination)}
      >
        <Icon size={18} />
      </Button>
    ));
  return (
    <nav
      className="navigation-rail"
      aria-label="折叠导航"
      hidden={hidden}
      inert={inert}
    >
      <Button
        variant="ghost"
        size="icon"
        aria-label="展开左侧导航"
        title="展开左侧导航"
        onClick={onExpand}
      >
        <PanelLeftOpen size={18} />
      </Button>
      <div className="navigation-rail-main">{actions(main)}</div>
      <div className="navigation-rail-tools">{actions(tools)}</div>
    </nav>
  );
}
