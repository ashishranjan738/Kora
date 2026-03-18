import { createTheme } from '@mantine/core';

export const koraTheme = createTheme({
  primaryColor: 'blue',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Helvetica, Arial, sans-serif",
  fontFamilyMonospace: "'SF Mono', 'Fira Code', 'Cascadia Code', monospace",
  colors: {
    // Mantine requires 10-shade color arrays. We define them for component usage
    // while keeping CSS vars for backgrounds/borders (existing styles).
    blue: [
      '#e6f2ff', '#b3d9ff', '#80bfff', '#4da6ff', '#1a8cff',
      '#0073e6', '#005bb3', '#004480', '#002d4d', '#00161a',
    ],
    green: [
      '#e6fbeb', '#b3f2c5', '#80e99f', '#4de079', '#1ad753',
      '#00c73c', '#009e30', '#007524', '#004c18', '#00230b',
    ],
    red: [
      '#ffe6e5', '#ffb3b0', '#ff807a', '#ff4d45', '#ff1a0f',
      '#e60000', '#b30000', '#800000', '#4d0000', '#1a0000',
    ],
    yellow: [
      '#fff8e6', '#ffe8b3', '#ffd980', '#ffc94d', '#ffba1a',
      '#e6a300', '#b38000', '#805c00', '#4d3700', '#1a1300',
    ],
    grape: [
      '#f3e8ff', '#dbb8ff', '#c488ff', '#ac58ff', '#9428ff',
      '#7c00e6', '#6200b3', '#480080', '#2e004d', '#14001a',
    ],
  },
  other: {
    // Custom Kora values accessible via theme.other
    bgPrimary: 'var(--bg-primary)',
    bgSecondary: 'var(--bg-secondary)',
    bgTertiary: 'var(--bg-tertiary)',
    borderColor: 'var(--border-color)',
    textPrimary: 'var(--text-primary)',
    textSecondary: 'var(--text-secondary)',
    textMuted: 'var(--text-muted)',
    accentBlue: 'var(--accent-blue)',
    accentGreen: 'var(--accent-green)',
    accentYellow: 'var(--accent-yellow)',
    accentRed: 'var(--accent-red)',
    accentPurple: 'var(--accent-purple)',
  },
});
