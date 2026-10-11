/**
 * Examples built from layers — text, shapes and images, no code at all.
 *
 * Each one is a tight box rather than a full 1920×1080 frame: the box is what
 * the operator drags around the out in the Editor, so a bug that is 860 px wide
 * is an 860 px template. Layer coordinates are percent of that box.
 */
import { defaultPlayback, type Layer, type LayerStyle, type Transition } from "../types";
import type { GalleryExample } from "./gallery";
import { AMBER, CREAM, DISPLAY, FONT, LEMON, MARK, SAGE, SIGNAL, STUDIO, lowerThirdPlate, svgImage } from "./style";

let seq = 0;
function layerId(): string {
	seq += 1;
	return `layer_ex${Date.now().toString(36)}${seq.toString(36)}`;
}

type Box = { x: number; y: number; w: number; h?: number };

function rect(name: string, box: Required<Box>, style: LayerStyle): Omit<Layer, "z"> {
	return {
		id: layerId(),
		name,
		type: "shape",
		shape: "rect",
		x: box.x,
		y: box.y,
		width: box.w,
		height: box.h,
		style: { opacity: 1, rotation: 0, ...style },
	};
}

function image(name: string, box: Required<Box>, src: string): Omit<Layer, "z"> {
	return {
		id: layerId(),
		name,
		type: "image",
		src,
		x: box.x,
		y: box.y,
		width: box.w,
		height: box.h,
		style: { opacity: 1, rotation: 0 },
	};
}

/**
 * A text layer bound to a variable, with `fallback` shown while it is empty.
 * Given a height, the text is centred vertically in it — the way to sit a line
 * exactly in the middle of a plate.
 */
function text(
	name: string,
	box: Box,
	binding: string,
	fallback: string,
	style: LayerStyle,
): Omit<Layer, "z"> {
	return {
		id: layerId(),
		name,
		type: "text",
		x: box.x,
		y: box.y,
		width: box.w,
		height: box.h,
		binding,
		text: `{{${binding} ?? ${fallback}}}`,
		style: {
			fontFamily: FONT,
			fontWeight: 700,
			color: CREAM,
			align: "left",
			verticalAlign: box.h === undefined ? "top" : "middle",
			lineHeight: 1.08,
			opacity: 1,
			rotation: 0,
			...style,
		},
	};
}

/** Stacks layers bottom-to-top in the order they are listed. */
function stack(layers: Array<Omit<Layer, "z">>): Layer[] {
	return layers.map((layer, index) => ({ ...layer, z: index + 1 }));
}

const ease = (type: Transition["type"], durationMs: number, easing: string): Transition => ({
	type,
	durationMs,
	easing,
});

const OUT_QUINT = "cubic-bezier(.16,1,.3,1)";

/** Name and role on the two-storey plate; `variant` picks the colourway. */
export function lowerThirdLayers(
	variant: "studio" | "cream",
	bind: { name: string; role: string },
	fallback: { name: string; role: string },
): Layer[] {
	return stack([
		image("Plate", { x: 0, y: 0, w: 100, h: 100 }, lowerThirdPlate(variant)),
		text("Name", { x: 4.2, y: 0, w: 88, h: 67.4 }, bind.name, fallback.name, {
			fontSize: 62,
			fontWeight: 800,
			letterSpacing: -0.6,
			color: variant === "studio" ? CREAM : STUDIO,
		}),
		text("Role", { x: 4.2, y: 67.4, w: 54, h: 32.6 }, bind.role, fallback.role, {
			fontSize: 25,
			fontWeight: 700,
			textTransform: "uppercase",
			letterSpacing: 2.4,
			// The tab under the plate is the opposite colour of the plate.
			color: variant === "studio" ? STUDIO : CREAM,
		}),
	]);
}

// ------------------------------------------------------------------ score bug

const SCORE_PLATE = svgImage(
	860,
	100,
	"<rect width='860' height='100' fill='url(#studio)' fill-opacity='.97'/>" +
		"<polygon points='364,0 496,0 484,100 376,100' fill='#1a443c'/>" +
		"<rect width='860' height='3' fill='#ffffff' fill-opacity='.10'/>",
);

const scoreBug: GalleryExample = {
	id: "example-scorebug",
	kind: "layers",
	name: { en: "Score bug", ru: "Счёт матча" },
	summary: {
		en: "Teams, score and clock from variables. Change the score in Control and it changes on air.",
		ru: "Команды, счёт и время из переменных. Меняете счёт в Control — он меняется в эфире.",
	},
	place: { x: 3, y: 4.5 },
	template: (lang) => ({
		kind: "layers",
		width: 860,
		height: 100,
		layers: stack([
			image("Plate", { x: 0, y: 0, w: 100, h: 100 }, SCORE_PLATE),
			// The team colours are plain shapes, so they can be recoloured in the inspector.
			rect("Home colour", { x: 0, y: 0, w: 1.3, h: 100 }, { fill: SIGNAL }),
			rect("Away colour", { x: 98.7, y: 0, w: 1.3, h: 100 }, { fill: AMBER }),
			text("Home", { x: 4.2, y: 0, w: 27, h: 100 }, "match.home.name", lang === "ru" ? "ХОЗЯЕВА" : "HOME", {
				fontSize: 31,
				fontWeight: 800,
				textTransform: "uppercase",
				letterSpacing: 1.2,
			}),
			text("Home score", { x: 31.5, y: 0, w: 10.5, h: 100 }, "match.home.score", "0", {
				fontFamily: DISPLAY,
				fontSize: 84,
				fontWeight: 800,
				align: "center",
			}),
			text("Period", { x: 42.5, y: 15, w: 15 }, "match.period", lang === "ru" ? "1 тайм" : "1st", {
				fontSize: 16,
				align: "center",
				color: SAGE,
				textTransform: "uppercase",
				letterSpacing: 1.6,
			}),
			text("Clock", { x: 42.5, y: 38, w: 15 }, "match.clock", "00:00", {
				fontFamily: DISPLAY,
				fontSize: 46,
				fontWeight: 700,
				align: "center",
				color: LEMON,
			}),
			text("Away score", { x: 58, y: 0, w: 10.5, h: 100 }, "match.away.score", "0", {
				fontFamily: DISPLAY,
				fontSize: 84,
				fontWeight: 800,
				align: "center",
			}),
			text("Away", { x: 68.8, y: 0, w: 27, h: 100 }, "match.away.name", lang === "ru" ? "ГОСТИ" : "AWAY", {
				fontSize: 31,
				fontWeight: 800,
				align: "right",
				textTransform: "uppercase",
				letterSpacing: 1.2,
			}),
		]),
		inTransition: ease("slide-down", 520, OUT_QUINT),
		outTransition: ease("fade", 250, "ease-in"),
		// A score bug stays up for the whole match: it is switched on, not played.
		playback: { ...defaultPlayback(), mode: "loop" },
	}),
	data: (lang) => ({
		match:
			lang === "ru"
				? {
						home: { name: "Север", score: 2 },
						away: { name: "Юг", score: 1 },
						period: "2 тайм",
						clock: "67:40",
					}
				: {
						home: { name: "North", score: 2 },
						away: { name: "South", score: 1 },
						period: "2nd half",
						clock: "67:40",
					},
	}),
};

// ----------------------------------------------------------- guest from a list

const guest: GalleryExample = {
	id: "example-guest",
	kind: "layers",
	name: { en: "Guest from a list", ru: "Гость из списка" },
	summary: {
		en: "Bound to the list variable “guests”: pick a row in Control and that guest goes on air.",
		ru: "Привязан к списку guests: выбираете строку в Control — в эфир идёт этот гость.",
	},
	place: { x: 5, y: 72 },
	template: (lang) => ({
		kind: "layers",
		width: 1040,
		height: 184,
		layers: lowerThirdLayers(
			"cream",
			{ name: "guests.name", role: "guests.role" },
			lang === "ru"
				? { name: "Имя гостя", role: "Кто это" }
				: { name: "Guest name", role: "Who they are" },
		),
		inTransition: ease("wipe-right", 560, OUT_QUINT),
		outTransition: ease("wipe-left", 320, "ease-in"),
		playback: { ...defaultPlayback(), mode: "once", holdMs: 7000 },
	}),
	data: (lang) => ({
		guests:
			lang === "ru"
				? [
						{ name: "Анна Смирнова", role: "Эксперт" },
						{ name: "Пётр Орлов", role: "Гость студии" },
						{ name: "Мария Ким", role: "Аналитик" },
					]
				: [
						{ name: "Anna Reed", role: "Expert" },
						{ name: "Peter Holt", role: "Studio guest" },
						{ name: "Maria Kim", role: "Analyst" },
					],
	}),
};

// ----------------------------------------------------------------- topic card

/** A scrim that darkens the left of the frame and fades out to the right. */
const TOPIC_SCRIM = svgImage(
	1920,
	1080,
	"<defs><linearGradient id='scrim' x1='0' y1='0' x2='1' y2='0'>" +
		`<stop offset='0' stop-color='${STUDIO}' stop-opacity='.96'/>` +
		`<stop offset='.5' stop-color='${STUDIO}' stop-opacity='.76'/>` +
		`<stop offset='1' stop-color='${STUDIO}' stop-opacity='0'/>` +
		"</linearGradient></defs>" +
		"<rect width='1920' height='1080' fill='url(#scrim)'/>" +
		"<polygon points='124,404 300,404 296,416 124,416' fill='url(#signal)'/>",
);

const topic: GalleryExample = {
	id: "example-topic",
	kind: "layers",
	name: { en: "Topic card", ru: "Тема выпуска" },
	summary: {
		en: "A full-frame title between segments: kicker, headline and a line under it.",
		ru: "Полноэкранная заставка между блоками: рубрика, заголовок и строка под ним.",
	},
	template: (lang) => ({
		kind: "layers",
		width: 1920,
		height: 1080,
		layers: stack([
			image("Scrim", { x: 0, y: 0, w: 100, h: 100 }, TOPIC_SCRIM),
			text("Kicker", { x: 6.45, y: 41, w: 60 }, "topic.kicker", lang === "ru" ? "Далее" : "Coming up", {
				fontSize: 30,
				color: SIGNAL,
				textTransform: "uppercase",
				letterSpacing: 7,
			}),
			text("Title", { x: 6.3, y: 46.2, w: 86 }, "topic.title", lang === "ru" ? "Заголовок темы" : "Topic headline", {
				fontFamily: DISPLAY,
				fontSize: 168,
				fontWeight: 700,
				lineHeight: 0.9,
			}),
			text("Subtitle", { x: 6.45, y: 63, w: 60 }, "topic.subtitle", lang === "ru" ? "Одна строка подробностей" : "One line of detail", {
				fontSize: 40,
				fontWeight: 400,
				color: "#d9d3c0",
			}),
		]),
		inTransition: ease("fade", 600, "ease-out"),
		outTransition: ease("fade", 400, "ease-in"),
		playback: { ...defaultPlayback(), mode: "once", holdMs: 6000 },
	}),
	data: (lang) => ({
		topic:
			lang === "ru"
				? { kicker: "Далее", title: "Большой разговор", subtitle: "Начало в 19:00" }
				: { kicker: "Coming up", title: "The big conversation", subtitle: "Starts at 19:00" },
	}),
};

// ------------------------------------------------------------------- logo bug

/** The notGT mark as a stand-in logo and the Lemon pill behind the tag, in one image. */
const BUG_ART = svgImage(
	296,
	108,
	`<g transform='scale(.84375)'>${MARK}</g>` +
		`<rect x='128' y='27' width='168' height='54' rx='27' fill='${LEMON}'/>` +
		`<circle cx='159' cy='54' r='9' fill='${STUDIO}'/>`,
);

const logoBug: GalleryExample = {
	id: "example-logo-bug",
	kind: "layers",
	name: { en: "Logo bug with a live tag", ru: "Логотип с плашкой эфира" },
	summary: {
		en: "An image layer and a text tag in a corner. Swap the image source for your own logo.",
		ru: "Слой-картинка и текстовая плашка в углу. Замените источник картинки своим логотипом.",
	},
	place: { x: 81.5, y: 5 },
	template: (lang) => ({
		kind: "layers",
		width: 296,
		height: 108,
		layers: stack([
			image("Logo and pill", { x: 0, y: 0, w: 100, h: 100 }, BUG_ART),
			text("Tag", { x: 60, y: 25, w: 36, h: 50 }, "bug.label", lang === "ru" ? "ЭФИР" : "LIVE", {
				fontSize: 26,
				fontWeight: 800,
				textTransform: "uppercase",
				letterSpacing: 3.5,
				color: STUDIO,
			}),
		]),
		inTransition: ease("fade", 400, "ease-out"),
		outTransition: ease("fade", 300, "ease-in"),
		playback: { ...defaultPlayback(), mode: "loop" },
	}),
	data: (lang) => ({ bug: { label: lang === "ru" ? "Эфир" : "Live" } }),
};

export const layerExamples: GalleryExample[] = [scoreBug, guest, topic, logoBug];
