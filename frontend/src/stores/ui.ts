import { create } from "zustand";
import { persist } from "zustand/middleware";
import { DEFAULT_APPEARANCE, normalizeAppearance } from "../lib/appearance";
import type { Appearance, ThemeMode } from "../lib/appearance";
type UIState = Appearance & {
  sidebarOpen: boolean;
  libraryWidth: number;
  filesWidth: number;
  setTheme: (theme: ThemeMode) => void;
  setAppearance: (appearance: Partial<Appearance>) => void;
  toggleSidebar: () => void;
  setWidths: (libraryWidth: number, filesWidth: number) => void;
};
export const useUI = create<UIState>()(
  persist(
    (set) => ({
      ...DEFAULT_APPEARANCE,
      sidebarOpen: true,
      libraryWidth: 248,
      filesWidth: 334,
      setTheme: (theme) => set({ theme }),
      setAppearance: (appearance) =>
        set((state) => normalizeAppearance({ ...state, ...appearance })),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setWidths: (libraryWidth, filesWidth) =>
        set({
          libraryWidth: Math.min(360, Math.max(200, libraryWidth)),
          filesWidth: Math.min(500, Math.max(280, filesWidth)),
        }),
    }),
    {
      name: "zhicluster-ui",
      version: 1,
      migrate: (saved) => {
        const state = (saved || {}) as Partial<UIState>;
        return {
          ...normalizeAppearance(state),
          sidebarOpen: state.sidebarOpen ?? true,
          libraryWidth: Math.min(360, Math.max(200, state.libraryWidth || 248)),
          filesWidth: Math.min(500, Math.max(280, state.filesWidth || 334)),
        };
      },
      partialize: (state) => ({
        theme: state.theme,
        palette: state.palette,
        fontPairing: state.fontPairing,
        readingScale: state.readingScale,
        sidebarOpen: state.sidebarOpen,
        libraryWidth: state.libraryWidth,
        filesWidth: state.filesWidth,
      }),
    },
  ),
);
