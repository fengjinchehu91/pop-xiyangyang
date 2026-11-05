import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import { loadConfig } from "./config";
import "./styles.css";

loadConfig().then((cfg) => {
  createRoot(document.getElementById("root")!).render(<App cfg={cfg} />);
});
