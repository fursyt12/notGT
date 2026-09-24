import { interpolate } from "../shared/binding";
import type { TitleData, TitleTemplate } from "../shared/types";

const BASE_CSS = `html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
*{box-sizing:border-box}`;

/**
 * Runtime injected into every code-authored animation (in the web GUI *and* in
 * files dropped into `graphics/animations/`).
 *
 * Inside the animation the author gets:
 *   root            - the animation container (document.body)
 *   data            - the whole variable store
 *   vars(path, fb?) - read one binding path
 *   onData(fn)      - called now and on every variable change
 *   [data-bind=x]   - auto-updating text nodes
 */
export function runtimeShim(dataJson: string): string {
	return `(function(){
var _data = ${dataJson};
var _callbacks = [];
function get(path){
  var parts = String(path).replace(/\\[(\\d+)\\]/g, '.$1').split('.');
  var cur = _data;
  for (var i = 0; i < parts.length; i++) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[parts[i]];
  }
  return cur;
}
function str(value){
  if (value === null || value === undefined) return '';
  if (typeof value === 'object') { try { return JSON.stringify(value); } catch (e) { return ''; } }
  return String(value);
}
function applyBindings(){
  var nodes = document.querySelectorAll('[data-bind]');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    var text = str(get(el.getAttribute('data-bind')));
    if (el.textContent !== text) el.textContent = text;
  }
}
window.data = _data;
window.vars = function(path, fallback){
  var text = str(get(path));
  if (text === '' && fallback !== undefined) return fallback;
  return text;
};
window.onData = function(cb){
  if (typeof cb !== 'function') return;
  _callbacks.push(cb);
  try { cb(_data); } catch (e) { console.error(e); }
};
window.root = document.body;
window.notgt = { data: _data, vars: window.vars, onData: window.onData, root: window.root };
window.addEventListener('message', function(event){
  var msg = event.data;
  if (!msg || msg.type !== 'notgt:data') return;
  _data = msg.data || {};
  window.data = _data;
  window.notgt.data = _data;
  applyBindings();
  for (var i = 0; i < _callbacks.length; i++) {
    try { _callbacks[i](_data); } catch (e) { console.error(e); }
  }
});
applyBindings();
})();`;
}

function escapeScript(source: string): string {
	return source.replace(/<\/script/gi, "<\\/script");
}

function serialized(data: TitleData): string {
	return escapeScript(JSON.stringify(data ?? {})).replace(/</g, "\\u003c");
}

/**
 * Builds a self-contained document for an inline `kind: "code"` template.
 * `{{...}}` in the HTML/CSS is substituted once at load; for live values use
 * `vars()` / `onData()` / `[data-bind]` inside the animation.
 */
export function buildCodeDocument(
	template: TitleTemplate,
	data: TitleData,
): string {
	const code = template.code ?? { html: "", css: "", js: "" };
	const html = interpolate(code.html, data);
	const css = interpolate(code.css, data);
	return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<style>${BASE_CSS}
${css}</style>
</head>
<body>
${html}
<script>${runtimeShim(serialized(data))}</script>
<script>${escapeScript(code.js)}</script>
</body>
</html>`;
}

/**
 * Substitutes `{{...}}` in a whole HTML document *except* inside `<script>`
 * blocks, so a file-authored animation gets the same load-time substitution as
 * an inline one without ever rewriting its JavaScript.
 */
export function interpolateMarkup(html: string, data: TitleData): string {
	return html
		.split(/(<script[\s\S]*?<\/script>)/i)
		.map((chunk) => (/^<script/i.test(chunk) ? chunk : interpolate(chunk, data)))
		.join("");
}

/**
 * Builds a document from a file on disk (served over HTTP), injecting the same
 * runtime *before* the file's own scripts run. Relative asset URLs keep working
 * thanks to the injected `<base>`.
 *
 * This is what makes "write the animation as an .html file" behave exactly like
 * an inline code animation: same `{{...}}` substitution, same variables, same
 * live updates.
 */
export async function buildSourcedDocument(
	src: string,
	data: TitleData,
): Promise<string> {
	const url = new URL(src, window.location.origin);
	const response = await fetch(url.href, { credentials: "same-origin" });
	if (!response.ok) {
		throw new Error(`Failed to load ${url.href}: HTTP ${response.status}`);
	}
	const text = interpolateMarkup(await response.text(), data);
	const baseHref = url.href.slice(0, url.href.lastIndexOf("/") + 1);
	const injection =
		`<base href="${baseHref}">` +
		`<style>${BASE_CSS}</style>` +
		`<script>${runtimeShim(serialized(data))}</script>`;

	if (/<head[^>]*>/i.test(text)) {
		return text.replace(/<head[^>]*>/i, (match) => `${match}${injection}`);
	}
	if (/<html[^>]*>/i.test(text)) {
		return text.replace(/<html[^>]*>/i, (match) => `${match}<head>${injection}</head>`);
	}
	return `<!DOCTYPE html>\n<html lang="en"><head><meta charset="utf-8">${injection}</head>\n<body>${text}</body></html>`;
}

export type CodeSource = "inline" | "file" | "none";

/** Inline HTML wins over a file reference, so editing in the GUI forks the file. */
export function codeSource(template: TitleTemplate): CodeSource {
	const code = template.code;
	if (!code) return "none";
	if (code.html && code.html.trim() !== "") return "inline";
	if (code.src && code.src.trim() !== "") return "file";
	if (code.js || code.css) return "inline";
	return "none";
}
