import { designTokens } from "@revelai/design-system";

export const theme = {
  color: designTokens.color,
  font: {
    body: "Arimo",
    display: "Bebas Neue",
  },
  spacing: {
    edge: 28,
    rule: 1,
    touchTarget: 44,
  },
} as const;
