import { lowerThirdLayers } from "./examples/layers";
import {
	BUNDLE_NAME,
	type Out,
	type TitleTemplate,
	defaultPlayback,
} from "./types";

/** URL of an out page. This is what goes into OBS as a Browser Source. */
export function outUrl(outId: string, opts?: { token?: string }): string {
	const base = `/bundles/${BUNDLE_NAME}/graphics/out.html?out=${encodeURIComponent(outId)}`;
	return opts?.token ? `${base}&key=${encodeURIComponent(opts.token)}` : base;
}

/**
 * A ready to use lower third: the animation a new installation starts with,
 * and the starting point of every new layers animation.
 */
export function createDefaultTemplate(): TitleTemplate {
	const now = Date.now();
	return {
		id: "lower-third",
		name: "Lower third",
		kind: "layers",
		width: 1040,
		height: 184,
		layers: lowerThirdLayers(
			"ink",
			{ name: "speaker.name", role: "speaker.role" },
			{ name: "Имя Фамилия", role: "Должность" },
		),
		inTransition: { type: "wipe-right", durationMs: 560, easing: "cubic-bezier(.16,1,.3,1)" },
		outTransition: { type: "wipe-left", durationMs: 320, easing: "ease-in" },
		playback: { ...defaultPlayback(), mode: "once", holdMs: 8000, autoStart: false },
		createdAt: now,
		updatedAt: now,
	};
}

/** A code-authored example, to show the `js/html` path in action. */
export function createCodeSampleTemplate(): TitleTemplate {
	const now = Date.now();
	return {
		id: "code-sample",
		name: "Code sample (ticker)",
		kind: "code",
		width: 1920,
		height: 1080,
		layers: [],
		code: {
			html: `<div class="ticker">
  <span class="badge">{{ticker.label ?? LIVE}}</span>
  <div class="track"><span class="text">{{ticker.text ?? Введите текст бегущей строки}}</span></div>
</div>`,
			css: `/* The bar stays put and only the text travels inside .track, which clips it. */
.ticker {
  position: absolute; left: 4%; right: 4%; bottom: 8%;
  display: flex; align-items: stretch;
  font-family: Inter, "Segoe UI", Roboto, Arial, sans-serif; color: #fff;
  background: linear-gradient(180deg, rgba(24,33,45,.97), rgba(10,14,20,.97));
  clip-path: polygon(0 0, 100% 0, calc(100% - 26px) 100%, 0 100%);
}
.badge {
  position: relative; z-index: 1;
  display: flex; align-items: center;
  padding: 0 48px 0 28px;
  background: linear-gradient(135deg, #ff5245, #dc2a20);
  clip-path: polygon(0 0, 100% 0, calc(100% - 24px) 100%, 0 100%);
  font-size: 27px; font-weight: 800; letter-spacing: .14em; text-transform: uppercase;
}
.track { flex: 1; overflow: hidden; margin-left: -8px; }
.text {
  display: inline-block; padding: 19px 0;
  font-size: 36px; font-weight: 600; white-space: nowrap;
  will-change: transform;
}`,
			js: `// Runs inside the animation. \`vars\` holds the resolved {{bindings}},
// \`data\` is the whole variable store, \`root\` is this animation's container.
const el = root.querySelector('.text');
// Start at the left edge so the ticker is visible immediately, then let it
// scroll out and re-enter from the right.
const track = root.querySelector('.track');
let offset = 36;

function frame() {
  offset -= 2.2;
  if (offset < -el.offsetWidth) offset = track.clientWidth;
  el.style.transform = 'translateX(' + offset + 'px)';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Called whenever variables change, without reloading the page.
onData(() => {
  el.textContent = vars('ticker.text') || 'Введите текст бегущей строки';
});

// A code animation animates its own entrance and exit — see "Переходы" in the
// README. onShow fires once per show (and on a re-trigger), onHide when the
// placement leaves, and hideDone() lets the system drop the iframe right then.
onShow(() => {
  root.querySelector('.ticker').animate(
    [{ opacity: 0, transform: 'translateY(120%)' }, { opacity: 1, transform: 'none' }],
    { duration: 520, easing: 'cubic-bezier(.16,1,.3,1)' },
  );
});

onHide(() => {
  root.querySelector('.ticker').animate(
    [{ opacity: 1, transform: 'none' }, { opacity: 0, transform: 'translateY(120%)' }],
    { duration: 250, easing: 'ease-in', fill: 'forwards' },
  );
}, 250);`,
			exitMs: 250,
		},
		inTransition: { type: "none", durationMs: 0 },
		outTransition: { type: "none", durationMs: 0 },
		playback: { mode: "once", intervalMs: 30000, holdMs: 20000, autoStart: false },
		createdAt: now,
		updatedAt: now,
	};
}

export function createDefaultOut(outId = "main"): Out {
	const now = Date.now();
	return {
		id: outId,
		name: "Main",
		width: 1920,
		height: 1080,
		items: [],
		createdAt: now,
		updatedAt: now,
	};
}
