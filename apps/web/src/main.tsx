import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./app";
import "./styles.css";

const container = document.getElementById("root");

if (!container) {
  throw new Error("RevelAI could not find its application root.");
}

createRoot(container).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
