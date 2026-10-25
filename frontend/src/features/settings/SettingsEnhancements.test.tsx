import { afterEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { AppearancePreview } from "./AppearancePreview";
import { Statistics } from "./Statistics";
import {
  DEFAULT_APPEARANCE,
  normalizeAppearance,
  PALETTES,
} from "../../lib/appearance";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("外观和统计", () => {
  it("六种配色都能持久化标准化，未知配色恢复默认", () => {
    expect(PALETTES).toHaveLength(6);
    for (const palette of PALETTES)
      expect(normalizeAppearance({ palette: palette.id }).palette).toBe(
        palette.id,
      );
    expect(normalizeAppearance({ palette: "unknown" as never }).palette).toBe(
      "ink",
    );
  });
  it("预览跟随系统主题和受控视图，始终不改变页面外观", () => {
    let change: (() => void) | undefined;
    const system = {
      matches: false,
      addEventListener: vi.fn((_event, callback) => {
        change = callback;
      }),
      removeEventListener: vi.fn(),
    };
    vi.stubGlobal(
      "matchMedia",
      vi.fn(() => system),
    );
    const original = document.documentElement.dataset.theme;
    const appearance = {
      ...DEFAULT_APPEARANCE,
      theme: "system" as const,
      palette: "violet" as const,
    };
    const { unmount, rerender } = render(
      <AppearancePreview appearance={appearance} view="page" />,
    );
    const preview = screen
      .getByRole("region", { name: "外观效果预览" })
      .querySelector(".zc-theme-preview")!;
    expect(preview).toHaveAttribute("data-theme", "light");
    act(() => {
      system.matches = true;
      change?.();
    });
    expect(preview).toHaveAttribute("data-theme", "dark");
    rerender(<AppearancePreview appearance={appearance} view="reading" />);
    expect(preview).toHaveTextContent("把零散的灵感");
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(document.documentElement.dataset.theme).toBe(original);
    unmount();
    expect(system.removeEventListener).toHaveBeenCalledWith("change", change);
  });
  it("统计读取失败可重试，空知识库正确显示零", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "统计暂不可用" }), {
          status: 503,
        }),
      )
      .mockResolvedValue(
        new Response(
          JSON.stringify({
            knowledge_bases: 1,
            documents: 0,
            folders: 0,
            tags: 0,
            conversations: 0,
            messages: 0,
            storage_bytes: 0,
            chunks: 0,
            indexed_documents: 0,
            failed_jobs: 0,
          }),
        ),
      );
    vi.stubGlobal("fetch", fetcher);
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    render(
      <QueryClientProvider client={client}>
        <Statistics
          kbId="empty-kb"
          bases={[
            { id: "empty-kb", name: "空资料库", description: "", version: 1 },
          ]}
        />
      </QueryClientProvider>,
    );
    expect(await screen.findByText("统计暂不可用")).toBeVisible();
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByText("0 B")).toBeVisible();
    const documents = screen.getByText("有效文档").closest("div")!;
    expect(within(documents).getByText("0")).toBeVisible();
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    expect(String(fetcher.mock.calls[0][0])).toContain("kb_id=empty-kb");
  });
});
