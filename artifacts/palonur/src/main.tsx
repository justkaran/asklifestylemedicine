import { createRoot } from "react-dom/client";
import "@fontsource/source-sans-3/300.css";
import "@fontsource/source-sans-3/400.css";
import "@fontsource/source-sans-3/500.css";
import "@fontsource/source-sans-3/600.css";
import "@fontsource/source-sans-3/700.css";
import "@fontsource/source-sans-3/800.css";
import "@fontsource/source-serif-4/400.css";
import "@fontsource/source-serif-4/500.css";
import "@fontsource/source-serif-4/600.css";
import "@fontsource/source-serif-4/700.css";
import App from "./App";
import "./index.css";
import "./i18n";

// The bundle loaded successfully, so any stale-cache self-heal in index.html did
// its job. Strip the cache-busting marker from the URL so it stays clean.
if (location.search.indexOf("_cb=") !== -1) {
  const url = new URL(location.href);
  url.searchParams.delete("_cb");
  window.history.replaceState(null, "", url.pathname + url.search + url.hash);
}

createRoot(document.getElementById("root")!).render(<App />);
