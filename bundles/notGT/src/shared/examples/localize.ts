/**
 * English wording for the examples that were written in Russian.
 *
 * Their code stays one source: the Russian captions are swapped for English
 * ones when an example is added from an English dashboard. Every entry is the
 * caption together with the quotes or tags around it, so a short word such as
 * «ч» can only ever match the caption it was meant for.
 */
import type { ExampleLang } from "./gallery";

type Pairs = Array<[ru: string, en: string]>;

const quoted = (pairs: Pairs): Pairs => pairs.map(([ru, en]) => [`"${ru}"`, `"${en}"`]);
const tagged = (pairs: Pairs): Pairs => pairs.map(([ru, en]) => [`>${ru}<`, `>${en}<`]);

const TABLES: Record<string, Pairs> = {
	"lower-third": [
		["?? Имя Фамилия}}", "?? First Last}}"],
		["?? Должность}}", "?? Role}}"],
	],
	"code-sample": [["Введите текст бегущей строки", "Type the ticker text"]],
	"example-countdown": [
		...tagged([
			["До начала", "Starts in"],
			["идёт отсчёт", "counting down"],
			["осталось", "left"],
			["дн", "d"],
			["ч", "h"],
			["мин", "min"],
			["сек", "sec"],
		]),
		...quoted([
			["До начала", "Starts in"],
			["время вышло", "time is up"],
			["демо-цель +10 мин", "demo target +10 min"],
			["осталось меньше минуты", "under a minute left"],
			["идёт отсчёт", "counting down"],
		]),
	],
	"example-clock": [
		...tagged([
			["Москва", "Moscow"],
			["синхронизация…", "syncing…"],
		]),
		[
			'["Вс", "Пн", "Вт", "Ср", "Чт", "Пт", "Сб"]',
			'["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]',
		],
		...quoted([
			["января", "January"],
			["февраля", "February"],
			["марта", "March"],
			["апреля", "April"],
			["мая", "May"],
			["июня", "June"],
			["июля", "July"],
			["августа", "August"],
			["сентября", "September"],
			["октября", "October"],
			["ноября", "November"],
			["декабря", "December"],
			["свой источник", "custom source"],
			["неизвестный формат ответа", "unknown response format"],
			["[clock] %s недоступен: %s", "[clock] %s unavailable: %s"],
			["локальные часы · сеть недоступна", "local clock · network unavailable"],
		]),
	],
	"example-external-data": [
		...tagged([
			["Москва", "Moscow"],
			["загрузка", "loading"],
			["нет данных", "no data"],
			["ощущается", "feels like"],
			["влажность", "humidity"],
			["ветер", "wind"],
			["ещё не обновлялось", "not updated yet"],
		]),
		...quoted([
			["Москва", "Moscow"],
			["Ясно", "Clear"],
			["Малооблачно", "Mostly clear"],
			["Переменная облачность", "Partly cloudy"],
			["Пасмурно", "Overcast"],
			["Туман", "Fog"],
			["Изморозь", "Rime fog"],
			["Слабая морось", "Light drizzle"],
			["Морось", "Drizzle"],
			["Сильная морось", "Heavy drizzle"],
			["Ледяная морось", "Freezing drizzle"],
			["Сильная ледяная морось", "Heavy freezing drizzle"],
			["Небольшой дождь", "Light rain"],
			["Дождь", "Rain"],
			["Сильный дождь", "Heavy rain"],
			["Ледяной дождь", "Freezing rain"],
			["Сильный ледяной дождь", "Heavy freezing rain"],
			["Небольшой снег", "Light snow"],
			["Снег", "Snow"],
			["Сильный снег", "Heavy snow"],
			["Снежная крупа", "Snow grains"],
			["Ливень", "Showers"],
			["Сильный ливень", "Heavy showers"],
			["Очень сильный ливень", "Violent showers"],
			["Снегопад", "Snow showers"],
			["Сильный снегопад", "Heavy snow showers"],
			["Гроза", "Thunderstorm"],
			["Гроза с градом", "Thunderstorm with hail"],
			["Сильная гроза с градом", "Heavy thunderstorm with hail"],
			["Код ", "Code "],
			["в ответе нет блока current", "the response has no current block"],
			[" км/ч", " km/h"],
			["нет связи", "offline"],
			["в эфире", "live"],
			["данные от ", "data from "],
			[" мин назад", " min ago"],
			["обновлено в ", "updated at "],
			["загрузка", "loading"],
			["[weather] обновление не удалось: %s", "[weather] update failed: %s"],
			["нет данных", "no data"],
			["источник недоступен", "source unavailable"],
			["повторим через минуту", "retrying in a minute"],
		]),
	],
};

/** Returns `source` in the requested language; Russian is the source itself. */
export function localizeExampleText(id: string, source: string, lang: ExampleLang): string {
	if (lang === "ru") return source;
	let text = source;
	for (const [ru, en] of TABLES[id] ?? []) text = text.split(ru).join(en);
	return text;
}
