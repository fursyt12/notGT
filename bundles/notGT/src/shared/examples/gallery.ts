/**
 * The examples gallery: every ready-made animation the dashboard can add to a
 * library, built from layers and from code alike.
 *
 * This is separate from `index.ts` on purpose. That file feeds the one-time
 * server-side seeding; this one is only read by the dashboard, when the
 * operator picks an example — so an example can be added again after it was
 * edited or deleted, and comes in the dashboard's language.
 */
import { createCodeSampleTemplate, createDefaultTemplate } from "../defaults";
import type { TimerFormat, TimerMode } from "../timer";
import type { TemplateKind, TitleData, TitleTemplate } from "../types";
import { createExampleTemplates } from "./index";
import { karaokeExample } from "./karaoke";
import { kineticExample } from "./kinetic";
import { layerExamples } from "./layers";
import { localizeExampleText } from "./localize";
import { pollExample } from "./poll";
import { timerExample } from "./timer";

export type ExampleLang = "en" | "ru";
export type Localized = Record<ExampleLang, string>;

/** A timer an example shows; made when there is no timer with that key yet. */
export interface ExampleTimer {
	key: string;
	name: string;
	mode?: TimerMode;
	durationMs?: number;
	overtime?: boolean;
	format?: TimerFormat;
}

/** A template without the fields that are assigned when it is added. */
export type ExampleTemplate = Omit<TitleTemplate, "id" | "name" | "createdAt" | "updatedAt">;

export interface GalleryExample {
	/** Stable id of the example (not of the templates made from it). */
	id: string;
	kind: TemplateKind;
	name: Localized;
	/** What it shows, in one line, for the gallery. */
	summary: Localized;
	template(lang: ExampleLang): ExampleTemplate;
	/** Sample values for the variables it reads; only missing ones are added. */
	data?(lang: ExampleLang): TitleData;
	/** The timers it shows; only missing ones are made. */
	timers?(lang: ExampleLang): ExampleTimer[];
	/**
	 * Where it sits when placed on an out, in percent of the out. Absent = the
	 * top-left corner, which is right for a full-frame animation.
	 */
	place?: { x: number; y: number };
}

function strip(template: TitleTemplate): ExampleTemplate {
	const { id: _id, name: _name, createdAt: _created, updatedAt: _updated, ...rest } = template;
	return rest;
}

/** One of the code examples that ship as seeded templates, in `lang`. */
function seededCode(id: string, lang: ExampleLang): ExampleTemplate {
	const source =
		id === "code-sample"
			? createCodeSampleTemplate()
			: createExampleTemplates().find((template) => template.id === id);
	if (!source) throw new Error(`Unknown built-in example: ${id}`);
	const code = source.code ?? { html: "", css: "", js: "" };
	return {
		...strip(source),
		code: {
			...code,
			html: localizeExampleText(id, code.html, lang),
			js: localizeExampleText(id, code.js, lang),
		},
	};
}

const lowerThird: GalleryExample = {
	id: "lower-third",
	kind: "layers",
	name: { en: "Lower third", ru: "Плашка с именем" },
	summary: {
		en: "Name and role on a plate. The plain starting point for an animation built from layers.",
		ru: "Имя и должность на плашке. Простая основа для анимации из слоёв.",
	},
	place: { x: 5, y: 72 },
	template: (lang) => {
		const source = strip(createDefaultTemplate());
		return {
			...source,
			layers: source.layers.map((layer) =>
				layer.text ? { ...layer, text: localizeExampleText("lower-third", layer.text, lang) } : layer,
			),
		};
	},
	data: (lang) => ({
		speaker:
			lang === "ru"
				? { name: "Иван Петров", role: "Ведущий" }
				: { name: "John Carter", role: "Host" },
	}),
};

const ticker: GalleryExample = {
	id: "code-sample",
	kind: "code",
	name: { en: "Ticker", ru: "Бегущая строка" },
	summary: {
		en: "A crawl moved frame by frame, with a tag in front. The smallest complete code animation.",
		ru: "Строка, которая едет покадрово, с плашкой впереди. Самая короткая полная код-анимация.",
	},
	template: (lang) => ({
		...seededCode("code-sample", lang),
		// A ticker runs until it is taken off, not for a set time.
		playback: { ...createCodeSampleTemplate().playback, mode: "loop" },
	}),
	data: (lang) => ({
		ticker:
			lang === "ru"
				? { label: "LIVE", text: "notGT — титры, которыми управляют из браузера, Companion и по HTTP" }
				: { label: "LIVE", text: "notGT — titles driven from the browser, Companion and plain HTTP" },
	}),
};

const countdown: GalleryExample = {
	id: "example-countdown",
	kind: "code",
	name: { en: "Countdown", ru: "Обратный отсчёт" },
	summary: {
		en: "Shows a timer of the Control panel: days to seconds, a ring of time left, paused and time-up states.",
		ru: "Показывает таймер из панели Control: дни, часы, минуты, секунды, кольцо остатка, пауза и «время вышло».",
	},
	template: (lang) => seededCode("example-countdown", lang),
	data: () => ({ countdown: { timer: "countdown" } }),
	timers: (lang) => [
		{
			key: "countdown",
			name: lang === "ru" ? "До начала" : "Starts in",
			mode: "down",
			durationMs: 10 * 60_000,
			overtime: false,
		},
	],
};

const clock: GalleryExample = {
	id: "example-clock",
	kind: "code",
	name: { en: "Network clock", ru: "Часы по сетевому времени" },
	summary: {
		en: "Time from an API, corrected against the local clock, falling back honestly when offline.",
		ru: "Время из API с поправкой к локальным часам и честным откатом без сети.",
	},
	template: (lang) => seededCode("example-clock", lang),
};

const weather: GalleryExample = {
	id: "example-external-data",
	kind: "code",
	name: { en: "Weather from the internet", ru: "Погода из интернета" },
	summary: {
		en: "External JSON on air: a loading skeleton, and “stale data” instead of an empty screen.",
		ru: "Внешний JSON в эфире: скелетон загрузки и «данные устарели» вместо пустого экрана.",
	},
	template: (lang) => seededCode("example-external-data", lang),
};

/** Every example, in the order the gallery lists them. */
export const GALLERY: GalleryExample[] = [
	lowerThird,
	...layerExamples,
	kineticExample,
	pollExample,
	karaokeExample,
	ticker,
	timerExample,
	countdown,
	clock,
	weather,
];
