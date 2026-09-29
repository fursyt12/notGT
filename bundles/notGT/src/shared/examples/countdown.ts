import type { ExampleCode } from "./types";

/**
 * Пример — обратный отсчёт.
 *
 * Встроенный пример code-анимации: код лежит прямо в шаблоне (как в
 * «Code sample (ticker)»), поэтому его видно и можно править в панели Editor.
 * Документация по переменным — в комментарии внутри CSS.
 */
export const countdownExample: ExampleCode = {
	id: "example-countdown",
	name: "Пример — обратный отсчёт",
	html: String.raw`<div class="cd" id="cd">
	<div class="cd__head">
		<div class="cd__title" id="title">До начала</div>
		<div class="cd__state">
			<span class="cd__dot"></span>
			<span id="state">идёт отсчёт</span>
		</div>
	</div>

	<div class="ring" id="ring">
		<div class="ring__value"><span id="ring-value">100%</span><small>осталось</small></div>
	</div>

	<div class="digits">
		<div class="unit" id="u-days">
			<span class="num" id="days">00</span><span class="cap">дн</span>
		</div>
		<div class="unit" id="u-hours">
			<span class="num" id="hours">00</span><span class="cap">ч</span>
		</div>
		<div class="unit" id="u-minutes">
			<span class="num" id="minutes">10</span><span class="cap">мин</span>
		</div>
		<div class="unit" id="u-seconds">
			<span class="num" id="seconds">00</span><span class="cap">сек</span>
		</div>
	</div>
</div>`,
	css: String.raw`/*
 * ОБРАТНЫЙ ОТСЧЁТ (countdown).
 *
 * Что показывает пример:
 *   - расчёт «сколько осталось» от текущего времени до цели;
 *   - кольцо «сколько осталось» на conic-gradient, которое плавно
 *     тянется CSS-переходом по @property (JS меняет только число,
 *     анимацию делает CSS);
 *   - три визуальных состояния: ожидание, «осталось мало», «время вышло»;
 *   - живую реакцию на переменные: смена цели/заголовка в панели Control
 *     видна на экране без перезагрузки Browser Source.
 *
 * Переменные (все необязательные, у каждой есть фолбэк):
 *   countdown.title     — подпись над цифрами (по умолчанию «До начала»)
 *   countdown.target    — цель, ISO 8601: 2026-12-31T23:59:59+03:00
 *   countdown.from      — начало отсчёта для кольца прогресса (ISO 8601);
 *                         если не задано, берётся момент загрузки анимации
 *   countdown.urgent    — за сколько секунд до нуля включить «панику» (10)
 *   countdown.accent    — акцентный цвет (по умолчанию #ff3b30)
 *
 * Проверить руками:
 *   curl -X POST http://localhost:9090/api/data?mode=merge \
 *     -H 'content-type: application/json' \
 *     -d '{"countdown":{"title":"До эфира","target":"2027-01-01T00:00:00+03:00"}}'
 */

/* Кольцо прогресса анимируется CSS-переходом по кастомному свойству.
   Без @property переход по --p не работал бы: свойство осталось бы
   «строкой» и менялось бы скачком. */
@property --p {
	syntax: "<number>";
	inherits: false;
	initial-value: 0;
}

:root {
	--accent: #ff3b30;
	--ink: #ffffff;
	--muted: #8fd3ff;
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

.cd {
	position: absolute;
	left: 50%;
	bottom: 7%;
	transform: translateX(-50%);
	display: flex;
	align-items: center;
	gap: 34px;
	padding: 26px 42px 26px 30px;
	border-radius: 20px;
	background: var(--plate);
	box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55);
	font-family: Inter, "Segoe UI", Roboto, Arial, sans-serif;
	color: var(--ink);
	/* Вход анимации: карточка выезжает снизу и проявляется. */
	animation: cd-in 520ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes cd-in {
	from {
		opacity: 0;
		transform: translate(-50%, 26px) scale(0.97);
	}
	to {
		opacity: 1;
		transform: translate(-50%, 0) scale(1);
	}
}

/* Акцентная полоса слева «прорастает» после появления карточки. */
.cd::before {
	content: "";
	position: absolute;
	left: 0;
	top: 18px;
	bottom: 18px;
	width: 6px;
	border-radius: 0 6px 6px 0;
	background: var(--accent);
	transform-origin: top;
	animation: cd-bar 620ms 180ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
}

@keyframes cd-bar {
	from {
		transform: scaleY(0);
	}
	to {
		transform: scaleY(1);
	}
}

.cd__head {
	display: flex;
	flex-direction: column;
	gap: 6px;
	min-width: 190px;
}

.cd__title {
	font-size: 34px;
	font-weight: 700;
	line-height: 1.1;
}

.cd__state {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-size: 20px;
	font-weight: 600;
	letter-spacing: 0.08em;
	text-transform: uppercase;
	color: var(--muted);
}

/* Пульсирующая точка состояния — чистый CSS. */
.cd__dot {
	width: 10px;
	height: 10px;
	border-radius: 50%;
	background: currentColor;
	animation: cd-blink 1.6s ease-in-out infinite;
}

@keyframes cd-blink {
	0%,
	100% {
		opacity: 1;
		transform: scale(1);
	}
	50% {
		opacity: 0.35;
		transform: scale(0.75);
	}
}

/* --- кольцо прогресса ------------------------------------------- */

.ring {
	--p: 1;
	position: relative;
	width: 132px;
	height: 132px;
	border-radius: 50%;
	background:
		conic-gradient(
			from -90deg,
			var(--accent) calc(var(--p) * 360deg),
			rgba(255, 255, 255, 0.12) 0
		);
	transition: --p 260ms linear;
}

.ring::after {
	content: "";
	position: absolute;
	inset: 12px;
	border-radius: 50%;
	background: #08141c;
}

.ring__value {
	position: absolute;
	inset: 0;
	display: flex;
	flex-direction: column;
	align-items: center;
	justify-content: center;
	gap: 3px;
	z-index: 1;
	font-size: 30px;
	font-weight: 800;
	font-variant-numeric: tabular-nums;
	color: var(--muted);
}

.ring__value small {
	font-size: 11px;
	font-weight: 700;
	letter-spacing: 0.14em;
	text-transform: uppercase;
	opacity: 0.7;
}

/* --- цифры ------------------------------------------------------- */

.digits {
	display: flex;
	align-items: flex-end;
	gap: 22px;
}

.unit {
	display: flex;
	flex-direction: column;
	align-items: center;
	gap: 2px;
	min-width: 96px;
}

.num {
	font-size: 96px;
	font-weight: 800;
	line-height: 1;
	font-variant-numeric: tabular-nums;
	letter-spacing: -0.02em;
}

.cap {
	font-size: 20px;
	font-weight: 600;
	letter-spacing: 0.14em;
	text-transform: uppercase;
	color: var(--muted);
}

/* Смена значения: короткий «подброс» цифры. Класс ставит JS,
   саму анимацию рисует CSS. */
.unit.is-tick .num {
	animation: cd-tick 260ms ease-out;
}

@keyframes cd-tick {
	from {
		transform: translateY(-8px);
		opacity: 0.35;
	}
	to {
		transform: translateY(0);
		opacity: 1;
	}
}

/* --- состояния --------------------------------------------------- */

.cd.is-urgent .num {
	color: var(--accent);
}

.cd.is-urgent .ring {
	animation: cd-pulse 900ms ease-in-out infinite;
}

@keyframes cd-pulse {
	0%,
	100% {
		box-shadow: 0 0 0 0 rgba(255, 59, 48, 0);
	}
	50% {
		box-shadow: 0 0 0 10px rgba(255, 59, 48, 0.22);
	}
}

.cd.is-done .digits {
	opacity: 0.25;
}

.cd.is-done .ring {
	box-shadow: 0 0 0 2px var(--accent);
	animation: cd-done 2.4s ease-in-out infinite;
}

@keyframes cd-done {
	0%,
	100% {
		box-shadow: 0 0 0 2px var(--accent);
	}
	50% {
		box-shadow: 0 0 0 9px rgba(255, 59, 48, 0.22);
	}
}

@media (prefers-reduced-motion: reduce) {
	.cd,
	.cd::before,
	.cd__dot,
	.cd.is-urgent .ring,
	.cd.is-done .ring {
		animation: none;
	}
}`,
	exitMs: 300,
	js: String.raw`(function () {
	"use strict";

	var DEFAULT_LEAD_MS = 10 * 60 * 1000; // демо-цель: +10 минут
	var DEFAULT_URGENT_S = 10;

	// root — контейнер анимации (document.body). Скрипт стоит в конце
	// body, поэтому DOM уже разобран.
	var el = {
		card: root.querySelector("#cd"),
		title: root.querySelector("#title"),
		state: root.querySelector("#state"),
		ringValue: root.querySelector("#ring-value"),
		ring: root.querySelector("#ring"),
		days: root.querySelector("#days"),
		hours: root.querySelector("#hours"),
		minutes: root.querySelector("#minutes"),
		seconds: root.querySelector("#seconds"),
	};
	var units = {
		days: root.querySelector("#u-days"),
		hours: root.querySelector("#u-hours"),
		minutes: root.querySelector("#u-minutes"),
		seconds: root.querySelector("#u-seconds"),
	};

	// Демо-цель фиксируем один раз на жизнь iframe: иначе без
	// переменной отсчёт каждый кадр начинался бы заново.
	var demoTarget = Date.now() + DEFAULT_LEAD_MS;
	var startedAt = Date.now();
	var urgentSeconds = DEFAULT_URGENT_S;
	var lastText = {};

	function parseTime(value) {
		if (!value) return NaN;
		var text = String(value).trim();
		if (text === "") return NaN;
		// Голое число в переменной трактуем как Unix-время в мс.
		if (/^\d+$/.test(text)) return Number(text);
		var ms = Date.parse(text);
		return isNaN(ms) ? NaN : ms;
	}

	function pad2(n) {
		return n < 10 ? "0" + n : String(n);
	}

	/** Меняет текст и один раз запускает CSS-анимацию «подброса». */
	function setUnit(key, text) {
		if (lastText[key] === text) return;
		lastText[key] = text;
		el[key].textContent = text;
		var unit = units[key];
		unit.classList.remove("is-tick");
		// reflow, иначе повторный класс не перезапустит анимацию
		void unit.offsetWidth;
		unit.classList.add("is-tick");
	}

	function readConfig() {
		var target = parseTime(vars("countdown.target", ""));
		var from = parseTime(vars("countdown.from", ""));
		var urgent = parseInt(vars("countdown.urgent", ""), 10);

		if (!isNaN(from)) startedAt = from;
		urgentSeconds = isNaN(urgent) || urgent < 0 ? DEFAULT_URGENT_S : urgent;

		el.card.style.setProperty(
			"--accent",
			vars("countdown.accent", "#ff3b30"),
		);
		// Подпись ставим из JS с фолбэком: у [data-bind] фолбэка нет,
		// пустая переменная затёрла бы текст в HTML.
		el.title.textContent = vars("countdown.title", "До начала");

		return { target: isNaN(target) ? demoTarget : target, isDemo: isNaN(target) };
	}

	var config = readConfig();

	function render() {
		var remaining = config.target - Date.now();

		if (remaining <= 0) {
			el.card.classList.remove("is-urgent");
			el.card.classList.add("is-done");
			el.state.textContent = vars("countdown.label", "время вышло");
			el.ringValue.textContent = "0%";
			el.ring.style.setProperty("--p", 0);
			setUnit("days", "00");
			setUnit("hours", "00");
			setUnit("minutes", "00");
			setUnit("seconds", "00");
			return;
		}

		var totalSeconds = Math.floor(remaining / 1000);
		var days = Math.floor(totalSeconds / 86400);
		var hours = Math.floor((totalSeconds % 86400) / 3600);
		var minutes = Math.floor((totalSeconds % 3600) / 60);
		var seconds = totalSeconds % 60;

		setUnit("days", pad2(days));
		setUnit("hours", pad2(hours));
		setUnit("minutes", pad2(minutes));
		setUnit("seconds", pad2(seconds));

		// Кольцо показывает, сколько времени ещё ОСТАЛОСЬ: в начале
		// полное, к нулю пустеет. Если старт позже цели — считаем, что
		// осталось нечего.
		var span = config.target - startedAt;
		var left = span > 0 ? remaining / span : 0;
		left = Math.max(0, Math.min(1, left));
		el.ring.style.setProperty("--p", left);
		el.ringValue.textContent = Math.round(left * 100) + "%";

		var urgent = totalSeconds <= urgentSeconds;
		el.card.classList.toggle("is-urgent", urgent);
		el.card.classList.remove("is-done");

		if (config.isDemo) el.state.textContent = "демо-цель +10 мин";
		else if (urgent) el.state.textContent = "осталось меньше минуты";
		else el.state.textContent = "идёт отсчёт";
	}

	// requestAnimationFrame вместо setInterval: значение всегда
	// считается от Date.now(), поэтому отсчёт не «уезжает» и не
	// накапливает дрейф, даже если вкладку на время скрыли.
	function loop() {
		render();
		requestAnimationFrame(loop);
	}

	// Переменные меняются — перечитываем цель и перерисовываем сразу.
	onData(function () {
		config = readConfig();
		render();
	});

	requestAnimationFrame(loop);
})();

// Уход делает сам код: система обёртку не анимирует (см. «Переходы»).
onHide(() => {
	root.querySelectorAll(".cd").forEach((el) =>
		el.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" }),
	);
}, 300);`,
};
