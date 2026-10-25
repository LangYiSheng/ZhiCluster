import { useEffect, useState, type CSSProperties } from "react";
import {
  BookOpen,
  FileText,
  Folder,
  MessageSquare,
  Search,
  Sparkles,
} from "lucide-react";
import type { Appearance } from "../../lib/appearance";
export function AppearancePreview({
  appearance,
  view,
}: {
  appearance: Appearance;
  view: "page" | "reading";
}) {
  const [systemDark, setSystemDark] = useState(
    () => window.matchMedia("(prefers-color-scheme: dark)").matches,
  );
  useEffect(() => {
    const system = window.matchMedia("(prefers-color-scheme: dark)");
    const update = () => setSystemDark(system.matches);
    system.addEventListener("change", update);
    return () => system.removeEventListener("change", update);
  }, []);
  const theme =
    appearance.theme === "system"
      ? systemDark
        ? "dark"
        : "light"
      : appearance.theme;
  return (
    <section className="zc-preview-card" aria-label="外观效果预览">
      <div className="zc-preview-heading">
        <strong>{view === "page" ? "页面预览" : "阅读预览"}</strong>
        <small>保存前先看看</small>
      </div>
      <div
        className="zc-theme-preview"
        data-theme={theme}
        data-palette={appearance.palette}
        data-font-pairing={appearance.fontPairing}
        data-view={view}
        style={{ "--reading-scale": appearance.readingScale } as CSSProperties}
      >
        <div>
          {view === "page" ? (
            <div className="zc-preview-workspace">
              <aside>
                <BookOpen size={18} />
                <b>知簇</b>
                <span className="active">
                  <MessageSquare size={12} />
                  知识对话
                </span>
                <span>
                  <FileText size={12} />
                  文档管理
                </span>
                <small>个人知识库</small>
                <span>
                  <Folder size={12} />
                  我的知识笔记
                </span>
              </aside>
              <main>
                <header>
                  我的知识笔记
                  <Search size={12} />
                </header>
                <div className="zc-preview-chat">
                  <Sparkles size={23} />
                  <h3>让知识产生连接</h3>
                  <p>从你的文档出发，寻找答案。</p>
                  <div className="zc-preview-composer">
                    向你的知识库提问…<i>↑</i>
                  </div>
                </div>
              </main>
            </div>
          ) : (
            <article className="zc-preview-reading">
              <small>阅读预览 · 我的知识笔记</small>
              <h3>把零散的灵感，连成自己的知识</h3>
              <p>
                知识不止是收藏。一次标注、一条线索，都可能成为下一次思考的起点。
              </p>
              <blockquote>给阅读留一点空间，让重要的内容自然浮现。</blockquote>
              <h4>从一份资料开始</h4>
              <p>
                整理你的笔记，在文档之间发现新的联系。正文会跟随你选择的字体、配色和字号变化。
              </p>
            </article>
          )}
        </div>
      </div>
    </section>
  );
}
