/**
 * Palonur expert-agent embed loader.
 *
 * One-line install — drop a single <script> tag on any page:
 *
 *   <script src="https://palonur.com/embed-agent.js"
 *           data-pillar="communication"
 *           data-color="#0a7"
 *           data-bg="#ffffff"
 *           data-logo="https://your-site.com/logo.png"
 *           data-name="Matt Abrahams"
 *           data-height="560"></script>
 *
 * The script reads its own data-* attributes, derives its origin from its own
 * src, and injects a themed iframe pointing at /embed-agent. All theming flows
 * through the iframe URL params, so the raw iframe URL works as a fallback.
 */
(function () {
  var current =
    document.currentScript ||
    (function () {
      var s = document.getElementsByTagName("script");
      return s[s.length - 1];
    })();
  if (!current) return;

  function origin(src) {
    try {
      return new URL(src, window.location.href).origin;
    } catch (e) {
      return "https://palonur.com";
    }
  }

  var base = origin(current.src);
  var d = current.dataset || {};
  var pillar = d.pillar || "communication";
  var height = parseInt(d.height, 10) || 560;

  var params = new URLSearchParams();
  params.set("pillar", pillar);
  if (d.color) params.set("color", d.color);
  if (d.bg) params.set("bg", d.bg);
  if (d.logo) params.set("logo", d.logo);
  if (d.name) params.set("name", d.name);

  var url = base + "/embed-agent?" + params.toString();

  var iframe = document.createElement("iframe");
  iframe.src = url;
  iframe.title = "Ask " + (d.name || pillar) + " — Science, signed, by Palonur";
  iframe.loading = "lazy";
  iframe.setAttribute("frameborder", "0");
  iframe.style.cssText =
    "width:100%;max-width:680px;height:" +
    height +
    "px;border:0;border-radius:14px;";

  var mountId = d.target;
  var mount = mountId ? document.getElementById(mountId) : null;
  if (mount) {
    mount.appendChild(iframe);
  } else if (current.parentNode) {
    current.parentNode.insertBefore(iframe, current.nextSibling);
  }
})();
