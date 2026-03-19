import { useEffect } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";
import { Navbar } from "./components/Navbar";
import { AllSessions } from "./pages/AllSessions";
import { SessionDetail } from "./pages/SessionDetail";
import { AgentView } from "./pages/AgentView";
import { SettingsPage } from "./pages/SettingsPage";
import { TaskBoardPage } from "./pages/TaskBoardPage";
import { MultiAgentView } from "./pages/MultiAgentView";
import { PlaybooksPage } from "./pages/PlaybooksPage";
import { useThemeStore } from "./stores/themeStore";
import { BottomNav } from "./components/BottomNav";

export function App() {
  const resolved = useThemeStore((s) => s.resolved);
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", resolved);
  }, [resolved]);

  return (
    <BrowserRouter>
      <Navbar />
      <Routes>
        <Route path="/" element={<AllSessions />} />
        <Route path="/session/:sessionId" element={<SessionDetail />} />
        <Route
          path="/session/:sessionId/agent/:agentId"
          element={<AgentView />}
        />
        <Route path="/session/:sessionId/overview" element={<MultiAgentView />} />
        <Route path="/session/:sessionId/tasks" element={<TaskBoardPage />} />
        <Route path="/playbooks" element={<PlaybooksPage />} />
        <Route path="/settings" element={<SettingsPage />} />
      </Routes>
      <BottomNav />
    </BrowserRouter>
  );
}
