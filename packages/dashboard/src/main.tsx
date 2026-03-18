import '@mantine/core/styles.css';
import { createRoot } from "react-dom/client";
import { MantineProvider } from '@mantine/core';
import { koraTheme } from './theme';
import { useThemeStore } from './stores/themeStore';
import { App } from "./App";
import "./index.css";

function Root() {
  const resolved = useThemeStore((s) => s.resolved);

  return (
    <MantineProvider theme={koraTheme} forceColorScheme={resolved}>
      <App />
    </MantineProvider>
  );
}

createRoot(document.getElementById("root")!).render(<Root />);
