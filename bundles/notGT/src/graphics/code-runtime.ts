import { interpolate } from "../shared/binding";
import {
	CODE_EXIT_MAX_MS,
	CODE_MESSAGES,
	type TitleData,
	type TitleTemplate,
} from "../shared/types";

const BASE_CSS = `html,body{margin:0;padding:0;width:100%;height:100%;background:transparent;overflow:hidden}
*{box-sizing:border-box}`;

/** How long the out page waits for a code animation to declare its hooks. */
export const CODE_HOOKS_TIMEOUT_MS = 1000;
/** Exit time assumed when a code animation asks for a hide but gives no number. */
export const CODE_HIDE_FALLBACK_MS = 600;

/**
 * The exit budget for a code animation: what it declared with `onHide(fn, ms)`,
 * else the template's `code.exitMs`, else the fallback. The scheduler uses the
 * same number to start the hide early, so the animation is gone exactly when
 * the configured hold runs out.
 */
export function codeExitBudgetMs(template: TitleTemplate | undefined, declared: number): number {
	const value = declared > 0 ? declared : (template?.code?.exitMs ?? 0);
	if (!Number.isFinite(value) || value <= 0) return CODE_HIDE_FALLBACK_MS;
	return Math.min(CODE_EXIT_MAX_MS, Math.round(value));
}

/**
 * Runtime injected into every code-authored animation (in the web GUI *and* in
 * files dropped into `graphics/animations/`).
 *
 * Inside the animation the author gets:
 *   root            - the animation container (document.body)
 *   data            - the whole variable store
 *   vars(path, fb?) - read one binding path
 *   onData(fn)      - called now and on every variable change
 *   onShow(fn)      - the animation is (still) on screen: animate the entrance
 *   onHide(fn, ms?) - the animation is going away: animate the exit, `ms` is how
 *                     long the out page will wait before dropping the iframe
 *   hideDone()      - "my exit animation is over", drop me now
 *   [data-bind=x]   - auto-updating text nodes
 *
 * Registering `onShow` / `onHide` hands that phase over to the animation: the
 * out page then skips the template's own in/out transition for it, instead of
 * animating the wrapper on top of the animation's own work.
 */
export function runtimeShim(dataJson: string): string {
	return `(function(){
var _data = ${dataJson};
var _callbacks = [];
var _phase = 'in';
var _showCbs = [];
var _hideCbs = [];
var _hideMs = 0;
function send(message){
  try { if (parent !== window) parent.postMessage(message, '*'); } catch (e) {}
}
function postHooks(){
  send({ type: '${CODE_MESSAGES.hooks}', show: _showCbs.length > 0, hide: _hideCbs.length > 0, hideMs: _hideMs });
}
function run(list){
  for (var i = 0; i < list.length; i++) {
    try { list[i](); } catch (e) { console.error(e); }
  }
}
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
// root — это document.body, но отдаём его геттером, а не значением: файловая
// анимация получает этот шим в <head>, когда document.body ещё null, и
// зафиксированное значение осталось бы null навсегда.
function bodyRoot(){ return document.body; }
Object.defineProperty(window, 'root', { get: bodyRoot, configurable: true });
// The animation is created when it goes on screen, so "in" is the phase it
// starts in; the out page re-sends the phase on every replay.
window.onShow = function(cb){
  if (typeof cb !== 'function') return;
  _showCbs.push(cb);
  if (_phase === 'in') run([cb]);
};
window.onHide = function(cb, ms){
  if (typeof cb !== 'function') return;
  _hideCbs.push(cb);
  if (typeof ms === 'number' && isFinite(ms) && ms > _hideMs) _hideMs = ms;
  postHooks();
  if (_phase === 'out') run([cb]);
};
window.hideDone = function(){
  send({ type: '${CODE_MESSAGES.phaseDone}' });
};
window.notgt = {
  data: _data,
  vars: window.vars,
  onData: window.onData,
  onShow: window.onShow,
  onHide: window.onHide,
  hideDone: window.hideDone,
  get phase(){ return _phase; },
  get root(){ return document.body; }
};
window.addEventListener('message', function(event){
  var msg = event.data;
  if (!msg || typeof msg !== 'object') return;
  if (msg.type === '${CODE_MESSAGES.phase}') {
    _phase = msg.phase === 'out' ? 'out' : 'in';
    run(_phase === 'out' ? _hideCbs : _showCbs);
    return;
  }
  if (msg.type !== '${CODE_MESSAGES.data}') return;
  _data = msg.data || {};
  window.data = _data;
  window.notgt.data = _data;
  applyBindings();
  for (var i = 0; i < _callbacks.length; i++) {
    try { _callbacks[i](_data); } catch (e) { console.error(e); }
  }
});
applyBindings();
// В файловой анимации на момент вставки шима элементов ещё нет — раскладываем
// [data-bind] повторно, когда документ разобран. Здесь же сообщаем наружу,
// какие фазы анимация берёт на себя: к этому моменту её <script> уже выполнен.
function onReady(){ applyBindings(); postHooks(); }
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', onReady);
} else {
  onReady();
}
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
