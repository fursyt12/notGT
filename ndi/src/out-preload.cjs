/**
 * Preload of an out's page (output.mjs): tells the sender how many titles
 * are on the out, as notGT's out page says on its root
 * (`data-notgt-on-air`). The sender paints at the out's full rate while any
 * is, received or not. A page that says nothing is never on air: it is
 * painted at the full rate for its receivers only, as before.
 *
 * CommonJS: a sandboxed page's preload cannot be a module.
 */
const { ipcRenderer } = require("electron");

let said;
function say() {
	const count = Number(document.documentElement.dataset.notgtOnAir) || 0;
	if (count === said) return;
	said = count;
	ipcRenderer.send("notgt:on-air", count);
}

window.addEventListener("DOMContentLoaded", () => {
	new MutationObserver(say).observe(document.documentElement, {
		attributes: true,
		attributeFilter: ["data-notgt-on-air"],
	});
	say();
});
