import {
	BUNDLE_NAME,
	type Layer,
	type Out,
	type TitleTemplate,
	defaultPlayback,
	defaultTransition,
	newId,
} from "./types";

/** URL of an out page. This is what goes into OBS as a Browser Source. */
export function outUrl(outId: string, opts?: { token?: string }): string {
	const base = `/bundles/${BUNDLE_NAME}/graphics/out.html?out=${encodeURIComponent(outId)}`;
	return opts?.token ? `${base}&key=${encodeURIComponent(opts.token)}` : base;
}

function textLayer(
	partial: Partial<Layer> & { id: string; x: number; y: number; z: number },
): Layer {
	return {
		type: "text",
		width: 60,
		style: {
			fontFamily: "Inter, 'Segoe UI', Roboto, Arial, sans-serif",
			fontSize: 56,
			fontWeight: 700,
			color: "#ffffff",
			align: "left",
			lineHeight: 1.15,
			opacity: 1,
			rotation: 0,
		},
		...partial,
	} as Layer;
}

/** A ready to use lower third, seeded on first run. */
export function createDefaultTemplate(): TitleTemplate {
	const now = Date.now();
	return {
		id: "lower-third",
		name: "Lower third",
		kind: "layers",
		width: 1920,
		height: 1080,
		layers: [
			{
				id: newId("layer"),
				name: "Accent",
				type: "shape",
				shape: "rect",
				x: 4,
				y: 74,
				width: 0.9,
				height: 14,
				z: 1,
				style: { fill: "#ff3b30", radius: 6, opacity: 1, rotation: 0 },
			},
			{
				id: newId("layer"),
				name: "Plate",
				type: "shape",
				shape: "rect",
				x: 4.9,
				y: 74,
				width: 44,
				height: 14,
				z: 2,
				style: { fill: "#0b1720", radius: 6, opacity: 0.92, rotation: 0 },
			},
			textLayer({
				id: newId("layer"),
				name: "Name",
				x: 6.4,
				y: 77,
				width: 40,
				z: 3,
				binding: "speaker.name",
				text: "{{speaker.name ?? Имя Фамилия}}",
				style: {
					fontFamily: "Inter, 'Segoe UI', Roboto, Arial, sans-serif",
					fontSize: 62,
					fontWeight: 700,
					color: "#ffffff",
					align: "left",
					lineHeight: 1.1,
					shadowColor: "rgba(0,0,0,0.55)",
					shadowBlur: 12,
					shadowOffsetY: 3,
					opacity: 1,
					rotation: 0,
				},
			}),
			textLayer({
				id: newId("layer"),
				name: "Role",
				x: 6.4,
				y: 82.4,
				width: 40,
				z: 4,
				binding: "speaker.role",
				text: "{{speaker.role ?? Должность}}",
				style: {
					fontFamily: "Inter, 'Segoe UI', Roboto, Arial, sans-serif",
					fontSize: 34,
					fontWeight: 500,
					color: "#8fd3ff",
					align: "left",
					lineHeight: 1.1,
					letterSpacing: 0.6,
					textTransform: "uppercase",
					opacity: 1,
					rotation: 0,
				},
			}),
		],
		inTransition: { type: "slide-left", durationMs: 420, easing: "cubic-bezier(.2,.8,.2,1)" },
		outTransition: { type: "fade", durationMs: 300, easing: "ease-in" },
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
  <span class="text">{{ticker.text ?? Введите текст бегущей строки}}</span>
</div>`,
			css: `.ticker {
  position: absolute; left: 4%; right: 4%; bottom: 8%;
  display: flex; align-items: stretch; overflow: hidden;
  border-radius: 10px; font-family: Inter, Arial, sans-serif;
  box-shadow: 0 10px 30px rgba(0,0,0,.45);
}
.badge {
  background: #ff3b30; color: #fff; font-weight: 800; letter-spacing: .12em;
  padding: 18px 28px; text-transform: uppercase; font-size: 30px;
  display: flex; align-items: center;
}
.text {
  background: rgba(8,20,28,.94); color: #fff; font-size: 38px; font-weight: 600;
  padding: 18px 28px; white-space: nowrap; flex: 1;
  will-change: transform;
}`,
			js: `// Runs inside the animation. \`vars\` holds the resolved {{bindings}},
// \`data\` is the whole variable store, \`root\` is this animation's container.
const el = root.querySelector('.text');
// Start at the left edge so the ticker is visible immediately, then let it
// scroll out and re-enter from the right.
let offset = 0;

function frame() {
  offset -= 2.2;
  if (offset < -el.scrollWidth) offset = root.clientWidth;
  el.style.transform = 'translateX(' + offset + 'px)';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

// Called whenever variables change, without reloading the page.
onData(() => {
  el.textContent = vars('ticker.text') || 'Введите текст бегущей строки';
});`,
		},
		inTransition: defaultTransition(),
		outTransition: { type: "fade", durationMs: 250 },
		playback: { mode: "loop", intervalMs: 30000, holdMs: 20000, autoStart: false },
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

/** Seed data applied when the replicants are empty (first run). */
export function seedTemplates(): TitleTemplate[] {
	return [createDefaultTemplate(), createCodeSampleTemplate()];
}

export function seedData(): Record<string, unknown> {
	return {
		speaker: { name: "Иван Петров", role: "Ведущий" },
		ticker: { label: "LIVE", text: "notGT — титры, управляемые из Companion" },
		sponsor: {
			label: "Партнёр",
			name: "ACME",
			meta: "Официальный партнёр трансляции",
			accent: "#ff3b30",
		},
		// Пример переменной-списка: в панели «Control» у неё можно выбрать
		// «текущий» элемент, и биндинг {{guests.name}} покажет именно его.
		guests: [
			{ name: "Анна Смирнова", role: "Эксперт" },
			{ name: "Пётр Иванов", role: "Гость" },
		],
	};
}
