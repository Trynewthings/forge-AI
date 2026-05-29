import React from "react";
import ReactDOM from "react-dom/client";
import AppShell from "./components/AppShell";
import App from "./App";
import "./index.css";
import "./theme.css";

// Set `?legacy=1` to render the old App.tsx side-by-side for comparison.
const useLegacy = new URLSearchParams(window.location.search).has("legacy");
const Root = useLegacy ? App : AppShell;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <Root />
  </React.StrictMode>,
);
