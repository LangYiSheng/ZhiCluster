import { create } from "zustand";
import { persist } from "zustand/middleware";
type UIState = {
  theme: "light" | "dark";
  sidebarOpen: boolean;
  libraryWidth: number;
  filesWidth: number;
  setTheme: (theme: "light" | "dark") => void;
  toggleSidebar: () => void;
  setWidths: (libraryWidth: number, filesWidth: number) => void;
};
export const useUI = create<UIState>()(
  persist(
    (set) => ({
      theme: "light",
      sidebarOpen: true,
      libraryWidth: 242,
      filesWidth: 334,
      setTheme: (theme) => set({ theme }),
      toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
      setWidths: (libraryWidth, filesWidth) =>
        set({
          libraryWidth: Math.min(360, Math.max(200, libraryWidth)),
          filesWidth: Math.min(500, Math.max(280, filesWidth)),
        }),
    }),
    { name: "zhicluster-ui" },
  ),
);
