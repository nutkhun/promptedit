import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./theme.css";
// Captions plug into the timeline, inspector and engine.
import "./captions";
// Software updates: automatic checks, Check for Updates…, the update alert.
import "./ui/updates";

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
