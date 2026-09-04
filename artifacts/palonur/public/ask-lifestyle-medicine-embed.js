/**
 * Ask Lifestyle Medicine WordPress/site embed.
 *
 * Example:
 * <script
 *   src="https://ask.example.edu/ask-lifestyle-medicine-embed.js"
 *   data-target="ask-lifestyle-medicine"
 *   data-height="760"
 * ></script>
 *
 * The loader contains no credentials. It derives the application origin from
 * its own script URL and embeds the dedicated /embed/slm route.
 */
(function () {
  "use strict";

  var script =
    document.currentScript ||
    (function () {
      var scripts = document.getElementsByTagName("script");
      return scripts[scripts.length - 1];
    })();
  if (!script) return;

  var data = script.dataset || {};
  var appOrigin;
  try {
    appOrigin = new URL(script.src, window.location.href).origin;
  } catch (_) {
    return;
  }

  var target = data.target ? document.getElementById(data.target) : null;
  var mount = target || document.createElement("div");
  if (!target && script.parentNode) {
    script.parentNode.insertBefore(mount, script.nextSibling);
  }

  var initialHeight = Math.max(520, parseInt(data.height || "760", 10) || 760);
  var iframe = document.createElement("iframe");
  iframe.src = appOrigin + "/embed/slm";
  iframe.title = data.title || "Ask Lifestyle Medicine";
  iframe.loading = data.loading === "eager" ? "eager" : "lazy";
  iframe.setAttribute("allow", "clipboard-write");
  iframe.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  iframe.style.cssText =
    "display:block;width:100%;max-width:100%;height:" +
    initialHeight +
    "px;border:0;background:#fff;";

  mount.appendChild(iframe);

  window.addEventListener("message", function (event) {
    if (event.origin !== appOrigin || event.source !== iframe.contentWindow) return;
    var message = event.data;
    if (!message || message.type !== "ask-lifestyle-medicine:resize") return;
    var nextHeight = Number(message.height);
    if (!Number.isFinite(nextHeight)) return;
    iframe.style.height = Math.max(520, Math.min(2400, nextHeight)) + "px";
  });
})();