export const designTokens = {
  color: {
    warmWhite: "#F7F5F0",
    nearBlack: "#10110F",
    deepEmerald: "#006B3C",
    mutedGray: "#686B67",
    borderGray: "#CDD1CC",
  },
  typography: {
    display: '"Bebas Neue", "Arial Narrow", sans-serif',
    body: "Inter, system-ui, sans-serif",
  },
} as const;

export type DesignTokens = typeof designTokens;
