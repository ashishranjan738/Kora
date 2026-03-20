import '@mantine/core/styles.css';
import '@mantine/dates/styles.css';
import '@mantine/notifications/styles.css';
import { createRoot } from "react-dom/client";
import { MantineProvider } from '@mantine/core';
import { Notifications } from '@mantine/notifications';
import { koraTheme } from './theme';
import { useThemeStore } from './stores/themeStore';
import { App } from "./App";
import "./index.css";

function Root() {
  const resolved = useThemeStore((s) => s.resolved);

  return (
    <MantineProvider theme={koraTheme} forceColorScheme={resolved}>
      <Notifications position="top-right" autoClose={4000} />
      <App />
    </MantineProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
