import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import "./styles.css";
import { applyTheme, isDesktop, readTheme } from "./lib";

applyTheme(readTheme());
if (isDesktop()) document.documentElement.dataset.desktop = "1";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
