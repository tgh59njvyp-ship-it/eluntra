import { StrictMode, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "../styles/tokens.css";
import "./dev.css";
import { useStore } from "../lib/store";
import { DeveloperApp } from "./DeveloperApp";

function Root() {
  const theme = useStore((s) => s.theme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);
  return <DeveloperApp />;
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
