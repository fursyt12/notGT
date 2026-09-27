import type { ExampleCode } from "./types";

/**
 * Пример — данные из интернета (погода).
 *
 * Встроенный пример code-анимации: код лежит прямо в шаблоне (как в
 * «Code sample (ticker)»), поэтому его видно и можно править в панели Editor.
 * Документация по переменным — в комментарии внутри CSS.
 */
export const externalDataExample: ExampleCode = {
	id: "example-external-data",
	name: "Пример — данные из интернета (погода)",
	html: String.raw`<div class="wx is-loading" id="wx">
	<div class="wx__bar" id="bar"></div>

	<div class="wx__top">
		<div class="wx__city" id="city">Москва</div>
		<div class="wx__state" id="state">
			<span class="wx__dot"></span><span id="state-text">загрузка</span>
		</div>
	</div>

	<div class="wx__main">
		<div class="wx__icon" id="icon" data-w="unknown">
			<svg data-i="clear" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<circle cx="32" cy="32" r="12" />
				<g class="wx__rays">
					<path d="M32 6v8M32 50v8M6 32h8M50 32h8M13.6 13.6l5.6 5.6M44.8 44.8l5.6 5.6M50.4 13.6l-5.6 5.6M19.2 44.8l-5.6 5.6" />
				</g>
			</svg>
			<svg data-i="partly" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<circle cx="24" cy="24" r="9" />
				<path d="M24 8v6M8 24h6M12.7 12.7l4.2 4.2M35.3 12.7l-4.2 4.2" />
				<path d="M22 50h24a8 8 0 0 0 0-16 11 11 0 0 0-21 3 7 7 0 0 0-3 13z" />
			</svg>
			<svg data-i="cloudy" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<path d="M16 46h32a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-9 15z" />
			</svg>
			<svg data-i="fog" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<path d="M16 28h32a9 9 0 0 0-1-17 12 12 0 0 0-22 4 8 8 0 0 0-9 13z" />
				<path d="M12 38h40M16 46h32M20 54h24" />
			</svg>
			<svg data-i="drizzle" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<path d="M16 40h32a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-9 15z" />
				<path class="wx__drop" d="M24 47v3" />
				<path class="wx__drop wx__drop--2" d="M32 47v3" />
				<path class="wx__drop wx__drop--3" d="M40 47v3" />
			</svg>
			<svg data-i="rain" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<path d="M16 38h32a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-9 15z" />
				<path class="wx__drop" d="M23 45l-2 7" />
				<path class="wx__drop wx__drop--2" d="M32 45l-2 7" />
				<path class="wx__drop wx__drop--3" d="M41 45l-2 7" />
			</svg>
			<svg data-i="snow" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<path d="M16 38h32a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-9 15z" />
				<path class="wx__drop" d="M24 47v6M21.5 48.5l5 3M26.5 48.5l-5 3" />
				<path class="wx__drop wx__drop--2" d="M40 47v6M37.5 48.5l5 3M42.5 48.5l-5 3" />
			</svg>
			<svg data-i="thunder" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<path d="M16 36h32a9 9 0 0 0 0-18 12 12 0 0 0-23 3 8 8 0 0 0-9 15z" />
				<path class="wx__drop" d="M34 42l-6 10h7l-4 8" />
			</svg>
			<svg data-i="unknown" viewBox="0 0 64 64" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round">
				<circle cx="32" cy="32" r="20" />
				<path d="M25 25a7 7 0 1 1 9 7v4" />
				<path d="M33 44h1" />
			</svg>
		</div>

		<div>
			<div class="wx__temp">
				<span class="wx__temp-value" id="temp">--</span
				><span class="wx__temp-unit" id="unit">°C</span>
			</div>
			<div class="wx__cond" id="cond">нет данных</div>
		</div>
	</div>

	<div class="wx__details">
		<div class="wx__detail">
			<span class="wx__detail-cap">ощущается</span>
			<span class="wx__detail-value" id="feels">--</span>
		</div>
		<div class="wx__detail">
			<span class="wx__detail-cap">влажность</span>
			<span class="wx__detail-value" id="humidity">--</span>
		</div>
		<div class="wx__detail">
			<span class="wx__detail-cap">ветер</span>
			<span class="wx__detail-value" id="wind">--</span>
		</div>
	</div>

	<div class="wx__foot">
		<span class="wx__ring" id="ring"></span>
		<span id="updated">ещё не обновлялось</span>
	</div>
</div>`,
	css: String.raw`/*
 * ДАННЫЕ ИЗ ИНТЕРНЕТА (open-meteo, без ключа и регистрации).
 *
 * Что показывает пример:
 *   - забор JSON из внешнего API и разбор ответа в переменные картинки;
 *   - три состояния: загрузка (скелетон), данные, «связь потеряна» —
 *     последние известные значения остаются на экране, а не пропадают;
 *   - иконку погоды, нарисованную инлайн-SVG и анимированную CSS
 *     (солнце вращает лучи, дождь «капает», карточка «дышит»);
 *   - периодическое обновление с индикатором давности данных.
 *
 * Переменные (все необязательные):
 *   weather.city            — подпись («Москва»)
 *   weather.latitude        — широта, по умолчанию 55.7558
 *   weather.longitude       — долгота, по умолчанию 37.6173
 *   weather.units           — celsius | fahrenheit
 *   weather.refreshMinutes  — период обновления, по умолчанию 10
 *   weather.api             — свой URL (подстановки {lat} {lon} {units})
 *   weather.accent          — акцентный цвет
 *
 * Проверить руками:
 *   curl -X POST http://localhost:9090/api/data?mode=merge \
 *     -H 'content-type: application/json' \
 *     -d '{"weather":{"city":"Санкт-Петербург","latitude":59.94,"longitude":30.31}}'
 */

@property --p {
	syntax: "<number>";
	inherits: false;
	initial-value: 0;
}

:root {
	--accent: #38bdf8;
	--ink: #ffffff;
	--muted: #9fb3c8;
	--warn: #ffb020;
	--plate: rgba(8, 20, 28, 0.9);
}

html,
body {
	margin: 0;
	width: 100%;
	height: 100%;
	background: transparent;
	overflow: hidden;
}

.wx {
	position: absolute;
	left: 4%;
	top: 8%;
	width: 430px;
	padding: 24px 28px;
	border-radius: 22px;
	background: var(--plate);
	box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
	font-family: Inter, "Segoe UI", Roboto, Arial, sans-serif;
	color: var(--ink);
	overflow: hidden;
	animation: wx-in 560ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes wx-in {
	from {
		opacity: 0;
		transform: translateX(-34px) scale(0.97);
	}
	to {
		opacity: 1;
		transform: translateX(0) scale(1);
	}
}

/* Тонкая полоса обновления по верхней кромке карточки. */
.wx__bar {
	position: absolute;
	left: 0;
	top: 0;
	height: 3px;
	width: 0;
	background: var(--accent);
	transition: width 600ms linear;
}

.wx__top {
	display: flex;
	align-items: center;
	justify-content: space-between;
	gap: 12px;
}

.wx__city {
	font-size: 30px;
	font-weight: 700;
	letter-spacing: 0.02em;
}

.wx__state {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-size: 16px;
	font-weight: 700;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--muted);
}

.wx__state.is-stale {
	color: var(--warn);
}

.wx__dot {
	width: 8px;
	height: 8px;
	border-radius: 50%;
	background: currentColor;
	animation: wx-pulse 2s ease-in-out infinite;
}

@keyframes wx-pulse {
	0%,
	100% {
		opacity: 1;
	}
	50% {
		opacity: 0.3;
	}
}

.wx__main {
	display: flex;
	align-items: center;
	gap: 20px;
	margin-top: 10px;
}

.wx__icon {
	width: 84px;
	height: 84px;
	flex: 0 0 auto;
	color: var(--accent);
	animation: wx-float 4.5s ease-in-out infinite;
}

@keyframes wx-float {
	0%,
	100% {
		transform: translateY(0);
	}
	50% {
		transform: translateY(-5px);
	}
}

/* Иконка — инлайн-SVG; CSS включает нужную по коду погоды. */
.wx__icon svg {
	display: none;
	width: 100%;
	height: 100%;
}

.wx__icon[data-w="clear"] svg[data-i="clear"],
.wx__icon[data-w="partly"] svg[data-i="partly"],
.wx__icon[data-w="cloudy"] svg[data-i="cloudy"],
.wx__icon[data-w="fog"] svg[data-i="fog"],
.wx__icon[data-w="drizzle"] svg[data-i="drizzle"],
.wx__icon[data-w="rain"] svg[data-i="rain"],
.wx__icon[data-w="snow"] svg[data-i="snow"],
.wx__icon[data-w="thunder"] svg[data-i="thunder"],
.wx__icon[data-w="unknown"] svg[data-i="unknown"] {
	display: block;
}

/* Лучи солнца вращаются сами — CSS-анимация внутри SVG. */
.wx__rays {
	transform-origin: 32px 32px;
	animation: wx-spin 24s linear infinite;
}

@keyframes wx-spin {
	to {
		transform: rotate(360deg);
	}
}

/* Капли дождя «падают». */
.wx__drop {
	animation: wx-drop 1.6s ease-in infinite;
}

.wx__drop--2 {
	animation-delay: 0.5s;
}

.wx__drop--3 {
	animation-delay: 1s;
}

@keyframes wx-drop {
	0% {
		opacity: 0;
		transform: translateY(-4px);
	}
	35% {
		opacity: 1;
	}
	100% {
		opacity: 0;
		transform: translateY(6px);
	}
}

.wx__temp {
	display: flex;
	align-items: baseline;
	gap: 4px;
	line-height: 1;
}

.wx__temp-value {
	font-size: 86px;
	font-weight: 800;
	font-variant-numeric: tabular-nums;
	letter-spacing: -0.03em;
}

.wx__temp-unit {
	font-size: 34px;
	font-weight: 600;
	color: var(--muted);
}

.wx__cond {
	margin-top: 6px;
	font-size: 26px;
	font-weight: 600;
	color: var(--muted);
}

.wx__details {
	display: flex;
	gap: 26px;
	margin-top: 18px;
	padding-top: 16px;
	border-top: 1px solid rgba(255, 255, 255, 0.1);
}

.wx__detail {
	display: flex;
	flex-direction: column;
	gap: 3px;
}

.wx__detail-cap {
	font-size: 15px;
	font-weight: 700;
	letter-spacing: 0.12em;
	text-transform: uppercase;
	color: var(--muted);
}

.wx__detail-value {
	font-size: 28px;
	font-weight: 700;
	font-variant-numeric: tabular-nums;
}

.wx__foot {
	display: flex;
	align-items: center;
	gap: 10px;
	margin-top: 16px;
	font-size: 17px;
	color: var(--muted);
}

/* Кольцо «до следующего обновления» — как в обратном отсчёте. */
.wx__ring {
	--p: 0;
	width: 22px;
	height: 22px;
	border-radius: 50%;
	background: conic-gradient(
		var(--accent) calc(var(--p) * 360deg),
		rgba(255, 255, 255, 0.14) 0
	);
	transition: --p 320ms linear;
}

.wx__ring::after {
	content: "";
	display: block;
	width: 12px;
	height: 12px;
	margin: 5px;
	border-radius: 50%;
	background: #08141c;
}

/* --- состояния --------------------------------------------------- */

/* Пока данных нет — карточка не пустая, а «дышит» скелетоном. */
.wx.is-loading .wx__temp-value,
.wx.is-loading .wx__cond,
.wx.is-loading .wx__detail-value {
	color: transparent;
	border-radius: 8px;
	background: linear-gradient(
		90deg,
		rgba(255, 255, 255, 0.08) 0%,
		rgba(255, 255, 255, 0.2) 50%,
		rgba(255, 255, 255, 0.08) 100%
	);
	background-size: 220% 100%;
	animation: wx-shimmer 1.4s linear infinite;
}

@keyframes wx-shimmer {
	from {
		background-position: 120% 0;
	}
	to {
		background-position: -120% 0;
	}
}

/* Данные устарели: гасим карточку, но НЕ прячем её. */
.wx.is-stale .wx__main,
.wx.is-stale .wx__details {
	opacity: 0.5;
	filter: saturate(0.4);
	transition:
		opacity 300ms ease,
		filter 300ms ease;
}

@media (prefers-reduced-motion: reduce) {
	.wx,
	.wx__icon,
	.wx__dot,
	.wx__rays,
	.wx__drop {
		animation: none;
	}
}`,
	js: String.raw`(function () {
	"use strict";

	var DEFAULTS = {
		city: "Москва",
		latitude: "55.7558",
		longitude: "37.6173",
		units: "celsius",
		refreshMinutes: 10,
	};
	var FETCH_TIMEOUT_MS = 8000;
	var RETRY_AFTER_ERROR_MS = 60 * 1000;

	// WMO weather code -> группа иконки + подпись.
	var WMO = [
		[0, "clear", "Ясно"],
		[1, "partly", "Малооблачно"],
		[2, "partly", "Переменная облачность"],
		[3, "cloudy", "Пасмурно"],
		[45, "fog", "Туман"],
		[48, "fog", "Изморозь"],
		[51, "drizzle", "Слабая морось"],
		[53, "drizzle", "Морось"],
		[55, "drizzle", "Сильная морось"],
		[56, "drizzle", "Ледяная морось"],
		[57, "drizzle", "Сильная ледяная морось"],
		[61, "rain", "Небольшой дождь"],
		[63, "rain", "Дождь"],
		[65, "rain", "Сильный дождь"],
		[66, "rain", "Ледяной дождь"],
		[67, "rain", "Сильный ледяной дождь"],
		[71, "snow", "Небольшой снег"],
		[73, "snow", "Снег"],
		[75, "snow", "Сильный снег"],
		[77, "snow", "Снежная крупа"],
		[80, "rain", "Ливень"],
		[81, "rain", "Сильный ливень"],
		[82, "rain", "Очень сильный ливень"],
		[85, "snow", "Снегопад"],
		[86, "snow", "Сильный снегопад"],
		[95, "thunder", "Гроза"],
		[96, "thunder", "Гроза с градом"],
		[99, "thunder", "Сильная гроза с градом"],
	];

	var el = {
		card: root.querySelector("#wx"),
		city: root.querySelector("#city"),
		icon: root.querySelector("#icon"),
		temp: root.querySelector("#temp"),
		unit: root.querySelector("#unit"),
		cond: root.querySelector("#cond"),
		feels: root.querySelector("#feels"),
		humidity: root.querySelector("#humidity"),
		wind: root.querySelector("#wind"),
		state: root.querySelector("#state"),
		stateText: root.querySelector("#state-text"),
		updated: root.querySelector("#updated"),
		ring: root.querySelector("#ring"),
		bar: root.querySelector("#bar"),
	};

	var lastGood = null; // последний удачный ответ
	var refreshMs = DEFAULTS.refreshMinutes * 60 * 1000;
	var cycleMs = refreshMs; // фактическая длина текущего цикла
	var nextRefreshAt = 0;
	var refreshTimer = null;

	function describe(code) {
		for (var i = 0; i < WMO.length; i++) {
			if (WMO[i][0] === code) {
				return { icon: WMO[i][1], label: WMO[i][2] };
			}
		}
		return { icon: "unknown", label: "Код " + code };
	}

	function config() {
		var units = vars("weather.units", DEFAULTS.units) === "fahrenheit"
			? "fahrenheit"
			: "celsius";
		var minutes = parseInt(vars("weather.refreshMinutes", ""), 10);
		return {
			city: vars("weather.city", DEFAULTS.city),
			latitude: vars("weather.latitude", DEFAULTS.latitude),
			longitude: vars("weather.longitude", DEFAULTS.longitude),
			units: units,
			refreshMinutes:
				isNaN(minutes) || minutes <= 0 ? DEFAULTS.refreshMinutes : minutes,
		};
	}

	function endpoint(cfg) {
		var custom = vars("weather.api", "").trim();
		var base =
			custom ||
			"https://api.open-meteo.com/v1/forecast?latitude={lat}&longitude={lon}" +
				"&current=temperature_2m,apparent_temperature,relative_humidity_2m," +
				"wind_speed_10m,weather_code&timezone=auto&temperature_unit={units}" +
				"&wind_speed_unit={wind}";
		return base
			.replace("{lat}", encodeURIComponent(cfg.latitude))
			.replace("{lon}", encodeURIComponent(cfg.longitude))
			.replace("{units}", cfg.units)
			.replace("{wind}", cfg.units === "fahrenheit" ? "mph" : "kmh");
	}

	async function fetchWithTimeout(url) {
		var controller = new AbortController();
		var timer = setTimeout(function () {
			controller.abort();
		}, FETCH_TIMEOUT_MS);
		try {
			var response = await fetch(url, {
				signal: controller.signal,
				cache: "no-store",
			});
			if (!response.ok) throw new Error("HTTP " + response.status);
			return await response.json();
		} finally {
			clearTimeout(timer);
		}
	}

	/** Разбирает ответ open-meteo в плоский снимок для отрисовки. */
	function snapshot(json) {
		var current = json && json.current;
		if (!current || typeof current.temperature_2m !== "number") {
			throw new Error("в ответе нет блока current");
		}
		return {
			temperature: Math.round(current.temperature_2m),
			feels: Math.round(current.apparent_temperature),
			humidity: Math.round(current.relative_humidity_2m),
			wind: Math.round(current.wind_speed_10m),
			code: current.weather_code,
			takenAt: Date.now(),
		};
	}

	function render(data, stale) {
		var info = describe(data.code);
		var cfg = config();

		el.icon.dataset.w = info.icon;
		el.temp.textContent = String(data.temperature);
		el.unit.textContent = cfg.units === "fahrenheit" ? "°F" : "°C";
		el.cond.textContent = info.label;
		el.feels.textContent = String(data.feels) + "°";
		el.humidity.textContent = String(data.humidity) + "%";
		el.wind.textContent = String(data.wind) + (cfg.units === "fahrenheit" ? " mph" : " км/ч");

		el.card.classList.remove("is-loading");
		el.card.classList.toggle("is-stale", Boolean(stale));
		el.state.classList.toggle("is-stale", Boolean(stale));
		el.stateText.textContent = stale ? "нет связи" : "в эфире";

		var when = new Date(data.takenAt);
		var stamp =
			("0" + when.getHours()).slice(-2) + ":" + ("0" + when.getMinutes()).slice(-2);
		var age = Math.round((Date.now() - data.takenAt) / 60000);
		el.updated.textContent = stale
			? "данные от " + stamp + " · " + age + " мин назад"
			: "обновлено в " + stamp;
	}

	function showLoading() {
		el.card.classList.add("is-loading");
		el.card.classList.remove("is-stale");
		el.state.classList.remove("is-stale");
		el.stateText.textContent = "загрузка";
	}

	async function refresh() {
		var cfg = config();
		el.card.style.setProperty("--accent", vars("weather.accent", "#38bdf8"));
		// Подпись ставим из JS с фолбэком: у [data-bind] фолбэка нет.
		el.city.textContent = cfg.city;
		if (!lastGood) showLoading();

		try {
			var json = await fetchWithTimeout(endpoint(cfg));
			lastGood = snapshot(json);
			render(lastGood, false);
		} catch (error) {
			// Ключевое решение: ошибка сети НЕ должна гасить графику.
			// Если хоть раз были данные — показываем их как устаревшие.
			console.warn("[weather] обновление не удалось: %s", error);
			if (lastGood) render(lastGood, true);
			else {
				el.card.classList.remove("is-loading");
				el.stateText.textContent = "нет данных";
				el.cond.textContent = "источник недоступен";
				el.updated.textContent = "повторим через минуту";
			}
		}

		refreshMs = cfg.refreshMinutes * 60 * 1000;
		cycleMs = lastGood ? refreshMs : RETRY_AFTER_ERROR_MS;
		nextRefreshAt = Date.now() + cycleMs;
		if (refreshTimer) clearTimeout(refreshTimer);
		refreshTimer = setTimeout(refresh, cycleMs);
	}

	/* Кольцо и полоса показывают, сколько осталось до обновления, и
	   обновляются ~4 раза в секунду — сама плавность на CSS-переходе. */
	function tick() {
		if (nextRefreshAt > 0) {
			var left = Math.max(0, nextRefreshAt - Date.now());
			var progress = 1 - left / cycleMs;
			progress = Math.max(0, Math.min(1, progress));
			el.ring.style.setProperty("--p", progress);
			el.bar.style.width = (progress * 100).toFixed(1) + "%";
		}
		setTimeout(tick, 250);
	}

	// Смена города/координат — сразу новый запрос, без ожидания таймера.
	var lastKey = "";
	onData(function () {
		var cfg = config();
		var key = [cfg.city, cfg.latitude, cfg.longitude, cfg.units].join("|");
		if (key === lastKey) return;
		lastKey = key;
		refresh();
	});

	tick();
})();`,
};
