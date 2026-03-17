import { create } from "zustand";

type ThemeMode = "light" | "dark" | "system";
type EditorTheme = "auto" | "vs-dark" | "vs" | "hc-black";
type TerminalTheme = "auto" | "dark" | "light";

export interface TerminalColors {
  background: string;
  foreground: string;
  cursor: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
}

const DARK_TERMINAL: TerminalColors = {
  background: "#0d1117",
  foreground: "#c9d1d9",
  cursor: "#58a6ff",
  selectionBackground: "#264f78",
  black: "#0d1117",
  red: "#f85149",
  green: "#3fb950",
  yellow: "#d29922",
  blue: "#58a6ff",
  magenta: "#bc8cff",
  cyan: "#39d2c0",
  white: "#c9d1d9",
};

const LIGHT_TERMINAL: TerminalColors = {
  background: "#ffffff",
  foreground: "#1f2328",
  cursor: "#0969da",
  selectionBackground: "#b6d7ff",
  black: "#24292f",
  red: "#cf222e",
  green: "#1a7f37",
  yellow: "#9a6700",
  blue: "#0969da",
  magenta: "#8250df",
  cyan: "#1b7c83",
  white: "#f6f8fa",
};

interface ThemeStore {
  mode: ThemeMode;
  resolved: "light" | "dark";
  setMode: (mode: ThemeMode) => void;
  editorTheme: EditorTheme;
  resolvedEditorTheme: string;
  setEditorTheme: (theme: EditorTheme) => void;
  terminalTheme: TerminalTheme;
  resolvedTerminalColors: TerminalColors;
  setTerminalTheme: (theme: TerminalTheme) => void;
}

function resolveTheme(m: ThemeMode): "light" | "dark" {
  if (m === "system") {
    return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  }
  return m;
}

function resolveEditorTheme(editorTheme: EditorTheme, appTheme: "light" | "dark"): string {
  if (editorTheme === "auto") {
    return appTheme === "dark" ? "vs-dark" : "vs";
  }
  return editorTheme;
}

function resolveTerminalColors(terminalTheme: TerminalTheme, appTheme: "light" | "dark"): TerminalColors {
  if (terminalTheme === "auto") {
    return appTheme === "dark" ? DARK_TERMINAL : LIGHT_TERMINAL;
  }
  return terminalTheme === "dark" ? DARK_TERMINAL : LIGHT_TERMINAL;
}

export const useThemeStore = create<ThemeStore>((set, get) => {
  const saved = localStorage.getItem("kora-theme") as ThemeMode | null;
  const mode = saved || "system";
  const savedEditorTheme = localStorage.getItem("kora-editor-theme") as EditorTheme | null;
  const editorTheme = savedEditorTheme || "auto";
  const savedTerminalTheme = localStorage.getItem("kora-terminal-theme") as TerminalTheme | null;
  const terminalTheme = savedTerminalTheme || "auto";
  const initialResolved = resolveTheme(mode);

  // Listen for system preference changes
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", (e) => {
    set((state) => {
      if (state.mode === "system") {
        const newResolved = e.matches ? "dark" : "light";
        return {
          resolved: newResolved,
          resolvedEditorTheme: resolveEditorTheme(state.editorTheme, newResolved),
          resolvedTerminalColors: resolveTerminalColors(state.terminalTheme, newResolved),
        };
      }
      return {};
    });
  });

  return {
    mode,
    resolved: initialResolved,
    editorTheme,
    resolvedEditorTheme: resolveEditorTheme(editorTheme, initialResolved),
    terminalTheme,
    resolvedTerminalColors: resolveTerminalColors(terminalTheme, initialResolved),
    setMode: (newMode) => {
      localStorage.setItem("kora-theme", newMode);
      const newResolved = resolveTheme(newMode);
      set((state) => ({
        mode: newMode,
        resolved: newResolved,
        resolvedEditorTheme: resolveEditorTheme(state.editorTheme, newResolved),
        resolvedTerminalColors: resolveTerminalColors(state.terminalTheme, newResolved),
      }));
    },
    setEditorTheme: (newEditorTheme) => {
      localStorage.setItem("kora-editor-theme", newEditorTheme);
      set((state) => ({
        editorTheme: newEditorTheme,
        resolvedEditorTheme: resolveEditorTheme(newEditorTheme, state.resolved),
      }));
    },
    setTerminalTheme: (newTerminalTheme) => {
      localStorage.setItem("kora-terminal-theme", newTerminalTheme);
      set((state) => ({
        terminalTheme: newTerminalTheme,
        resolvedTerminalColors: resolveTerminalColors(newTerminalTheme, state.resolved),
      }));
    },
  };
});
