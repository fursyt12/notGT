import type { ExampleCode } from "./types";

/**
 * Пример — обратный отсчёт.
 *
 * Показывает таймер из панели Control: сам он ничего не считает.
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
 *   - титр, который ПОКАЗЫВАЕТ таймер notGT, а не считает сам: «Старт»,
 *     «Пауза», «+1:00» нажимают в панели Control (или в Companion), и на
 *     всех out'ах одна и та же секунда — значение идёт от часов сервера;
 *   - timer(ключ, поле) в onData: onData вызывается на каждом тике таймера,
 *     поэтому никакого setInterval и requestAnimationFrame;
 *   - кольцо «сколько осталось» на conic-gradient, которое плавно
 *     тянется CSS-переходом по @property (JS меняет только число раз в
 *     секунду, анимацию между тиками делает CSS);
 *   - четыре визуальных состояния: идёт, пауза, «осталось мало», «время вышло».
 *
 * Переменные (все необязательные, у каждой есть фолбэк):
 *   countdown.timer     — ключ таймера из панели Control (countdown)
 *   countdown.title     — подпись над цифрами (по умолчанию — название таймера)
 *   countdown.urgent    — за сколько секунд до нуля включить «панику» (10)
 *   countdown.accent    — акцентный цвет (по умолчанию #ff5a8c)
 *
 * Проверить руками:
 *   curl -X POST http://localhost:9090/api/timers/countdown/set \
 *     -H 'content-type: application/json' -d '{"value":"0:30"}'
 *   curl -X POST http://localhost:9090/api/timers/countdown/start
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
	--accent: #ff5a8c;
	--ink: #f5ecda;
	--muted: #a9b8a8;
	--plate: linear-gradient(180deg, rgba(18, 54, 48, 0.97), rgba(10, 37, 31, 0.97));
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
	padding: 24px 60px 24px 40px;
	background: var(--plate);
	font-family: Montserrat, "Segoe UI", Roboto, Arial, sans-serif;
	color: var(--ink);
	/* Вход анимации: карточка выезжает снизу и проявляется. */
	animation: cd-in 520ms cubic-bezier(0.2, 0.8, 0.2, 1) both;
	clip-path: polygon(0 0, calc(100% - 34px) 0, 100% 34px, 100% 100%, 0 100%);
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
	top: 0;
	bottom: 0;
	width: 10px;
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
	font-size: 32px;
	font-weight: 800;
	line-height: 1.1;
	letter-spacing: -0.01em;
}

.cd__state {
	display: inline-flex;
	align-items: center;
	gap: 8px;
	font-size: 17px;
	font-weight: 600;
	letter-spacing: 0.12em;
	text-transform: uppercase;
	white-space: nowrap;
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
	/* Таймер тикает раз в секунду; переход заполняет промежуток. */
	transition: --p 1s linear;
}

.ring::after {
	content: "";
	position: absolute;
	inset: 12px;
	border-radius: 50%;
	background: #0a231e;
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
	font-family: Handjet, Montserrat, sans-serif;
	font-size: 42px;
	font-weight: 700;
	line-height: 0.8;
	font-variant-numeric: tabular-nums;
	color: var(--ink);
}

.ring__value small {
	font-family: Montserrat, "Segoe UI", Roboto, Arial, sans-serif;
	font-size: 11px;
	line-height: 1.2;
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
	font-family: Handjet, Montserrat, sans-serif;
	font-size: 136px;
	font-weight: 700;
	line-height: 0.74;
	font-variant-numeric: tabular-nums;
}

.cap {
	font-size: 17px;
	font-weight: 600;
	letter-spacing: 0.16em;
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

/* Пауза: цифры приглушены, точка не мигает. */
.cd.is-paused .num {
	opacity: 0.6;
}

.cd.is-paused .cd__dot {
	animation: none;
	opacity: 0.5;
}

.cd.is-urgent .num {
	color: var(--accent);
}

.cd.is-urgent .ring {
	animation: cd-pulse 900ms ease-in-out infinite;
}

@keyframes cd-pulse {
	0%,
	100% {
		box-shadow: 0 0 0 0 rgba(255, 90, 140, 0);
	}
	50% {
		box-shadow: 0 0 0 10px rgba(255, 90, 140, 0.22);
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
		box-shadow: 0 0 0 9px rgba(255, 90, 140, 0.22);
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
	var lastText = {};

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

	function setState(name) {
		el.card.classList.toggle("is-urgent", name === "urgent");
		el.card.classList.toggle("is-done", name === "done");
		el.card.classList.toggle("is-paused", name === "paused");
	}

	// Какой таймер показываем: его ключ из панели Control. Переменная, а
	// не константа — так один титр может показать любой таймер.
	function key() {
		return vars("countdown.timer", "countdown");
	}

	// onData вызывается сразу, на каждое изменение переменных и на каждом
	// тике таймера — своих часов у титра нет.
	onData(function () {
		var k = key();
		var urgent = parseInt(vars("countdown.urgent", ""), 10);
		if (isNaN(urgent) || urgent < 0) urgent = DEFAULT_URGENT_S;
		el.card.style.setProperty("--accent", vars("countdown.accent", "#ff5a8c"));
		// Подпись — из переменной, иначе название таймера.
		el.title.textContent = vars("countdown.title", timer(k, "name") || "До начала");

		// Таймера с таким ключом нет: говорим об этом, а не показываем нули.
		if (timer(k) === "") {
			setState("none");
			el.state.textContent = "нет такого таймера";
			el.ring.style.setProperty("--p", 0);
			el.ringValue.textContent = "—";
			setUnit("days", "--");
			setUnit("hours", "--");
			setUnit("minutes", "--");
			setUnit("seconds", "--");
			return;
		}

		var totalSeconds = Math.max(0, Number(timer(k, "totalSeconds")) || 0);
		var done = timer(k, "done") === "true";
		var running = timer(k, "running") === "true";

		setUnit("days", pad2(Math.floor(totalSeconds / 86400)));
		setUnit("hours", pad2(Math.floor((totalSeconds % 86400) / 3600)));
		setUnit("minutes", pad2(Math.floor((totalSeconds % 3600) / 60)));
		setUnit("seconds", pad2(totalSeconds % 60));

		// Кольцо показывает, сколько времени ещё ОСТАЛОСЬ: в начале полное,
		// к нулю пустеет. progress таймера — сколько прошло, от 0 до 1.
		var left = done ? 0 : 1 - (Number(timer(k, "progress")) || 0);
		left = Math.max(0, Math.min(1, left));
		el.ring.style.setProperty("--p", left);
		el.ringValue.textContent = Math.round(left * 100) + "%";

		if (done) {
			setState("done");
			el.state.textContent = "время вышло";
		} else if (!running) {
			setState("paused");
			el.state.textContent = "на паузе";
		} else if (totalSeconds <= urgent) {
			setState("urgent");
			el.state.textContent = "последние секунды";
		} else {
			setState("running");
			el.state.textContent = "идёт отсчёт";
		}
	});
})();

// Уход делает сам код: система обёртку не анимирует (см. «Переходы»).
onHide(() => {
	const card = root.querySelector(".cd");
	if (!card) return hideDone();
	card
		.animate([{ opacity: 1 }, { opacity: 0 }], { duration: 300, fill: "forwards" })
		.finished.then(hideDone)
		.catch(() => {});
}, 300);`,
};
