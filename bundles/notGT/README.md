# notGT — бандл `notGT`

**notGT** — это система веб-титров и broadcast-анимации, работающая как NodeCG-бандл.
Она даёт несколько независимых «выходов» (outs), каждый из которых открывается в OBS как
Browser Source по своему URL, набор анимаций — собранных из примитивов (текст, картинка,
gif, фигура) или написанных руками на HTML/CSS/JS, — и REST API, через который всё это
дёргают дашборд, Bitfocus Companion и любые внешние интеграции.

Серверная часть (extension) — единственный источник правды: она хранит состояние в
Replicant'ах, сама владеет таймерами воспроизведения и отдаёт наружу `GET /api/state`.
Графические страницы только рисуют то, что им приходит, поэтому состояние в API всегда
совпадает с тем, что на экране.

---

## Содержание

- [Ментальная модель](#ментальная-модель)
- [Быстрый старт](#быстрый-старт)
- [Дашборд: три панели](#дашборд-три-панели)
- [Конфигурация бандла](#конфигурация-бандла)
- [REST API](#rest-api)
- [Bitfocus Companion](#bitfocus-companion)
- [OBS Studio](#obs-studio)
- [Персистентность](#персистентность)
- [Написание code-анимации](#написание-code-анимации)
- [Траблшутинг](#траблшутинг)

---

## Ментальная модель

Четыре сущности и одно правило.

### Outs — выходы

**Out** — это один render target = один OBS Browser Source = один URL:

```
http://<host>/bundles/notGT/graphics/out.html?out=<outId>
```

У out'а есть `id`, `name`, дизайнерский размер `width`/`height` (по умолчанию 1920×1080) и
список размещений. Out'ы полностью независимы: несколько Browser Source'ов с разными
`?out=` работают одновременно, и каждый рисует только то, что адресовано ему. Out с
идентификатором `main` создаётся при первом запуске (см. ключ `defaultOutId`).

### Анимации / шаблоны (templates)

**Шаблон** (`template`) — это одна анимация целиком. Два вида (`kind`):

- **`layers`** — рисуется из примитивов: `text`, `image`, `gif`, `shape` (`rect`/`ellipse`).
  Каждый слой позиционируется в процентах от дизайнерского бокса шаблона (`x`, `y`,
  `width`, `height`), имеет стиль (шрифт, размер, цвет, обводка, тень, прозрачность,
  поворот), `z` для порядка наложения и либо `binding` (путь к переменной), либо `text`
  с подстановками `{{...}}`. Для `image`/`gif` слой `src` — это абсолютный URL,
  `/assets/<bundle>/<file>` или путь относительно бандла.
- **`code`** — авторский HTML/CSS/JS (`code.html`, `code.css`, `code.js`), который
  исполняется в sandboxed iframe. Контракт описан в разделе
  [«Написание code-анимации»](#написание-code-анимации).

У шаблона есть вход и выход (`inTransition` / `outTransition`: `none`, `fade`,
`slide-left/right/up/down`, `scale`, `wipe-left/right` плюс `durationMs`) и своя
конфигурация воспроизведения `playback` (используется, когда у размещения нет своей).

### Размещения (placements / items)

**Placement** — это шаблон, поставленный на конкретный out. У него свои координаты
`x`/`y` (в процентах от сцены out'а), `scale`, `enabled`, `held`, `order` и **своя**
`playback`, которая переопределяет шаблонную:

- `mode: "once"` — играет только по явному триггеру (`trigger`, `show` или команда из
  Companion);
- `mode: "loop"` — повторяется каждые `intervalMs` мс, оставаясь на экране `holdMs` мс за
  один проход;
- `autoStart: true` — цикл стартует автоматически при запуске NodeCG.

Отдельно от `playback` есть `held` — «показать и держать». Пока он включён (переключатель
**«показать»** в панели Control), размещение висит в эфире и не снимается ни по `holdMs`,
ни по расписанию `once`/`loop`; выключили — скрылось. `held` перекрывает `enabled`.

Один и тот же шаблон можно поставить на несколько out'ов или несколько раз на один out —
это разные размещения с разными `id`.

### Переменные (variables / data)

Глобальное хранилище значений (Replicant `titleData`), адресуемое путями:
`speaker.name`, `panel.items[0].title`. В шаблонах путь подставляется как
`{{speaker.name}}`, с фолбэком — `{{speaker.name ?? Guest}}`. Путь — английский
идентификатор, значение — что угодно (строка, число, bool, вложенный объект).

**Переменная-список.** Значением может быть массив; тогда переменная ведёт себя как
коллекция «выбери одно»:

```json
{ "guests": [ { "name": "Анна", "role": "Эксперт" },
              { "name": "Пётр", "role": "Гость" } ] }
```

Какой элемент считается текущим, хранит Replicant `selection` (`{ "guests": 1 }`).
Биндинг, который проходит сквозь массив, резолвится по выбранному элементу:
`{{guests.name}}` → `Пётр`, `{{guests.role}}` → `Гость`. Путь может заканчиваться на
самом массиве — `{{guests}}` вернёт выбранный объект. Явный индекс всегда главнее:
`{{guests[0].name}}` → `Анна`. Если ничего не выбрано, берётся элемент `0`.

В панели **Control** список показывается как есть: слева переменные, справа значения
выбранной; у списка можно пометить «текущий» элемент, добавить значение (＋), изменить,
переставить или удалить элемент. Смена текущего элемента сразу меняет картинку в эфире —
без перезагрузки Browser Source (проверено тестом, ~10 мс).

Переменную-скаляр можно превратить в список кнопкой «сделать списком».

У активного показа есть ещё **per-show override**: `data` в теле `POST /api/titles/:id/show`
накладывается поверх глобального хранилища, не меняя его. Это удобно, когда имена приходят
извне и в глобальных переменных им места нет.

### Служебное состояние

- Replicant `activeTitle` — «программа»: что сейчас показано, на каком out'е, с каким
  label и override'ами. Это то, что переживает перезапуск.
- Replicant `runtime` — производное: `playing` (`{outId: [itemId, ...]}`), `triggers` и
  `revision`. Пересчитывается на сервере и не сохраняется.
- Replicant `selection` — выбранный элемент для каждой переменной-списка
  (`{"guests": 1}`). Сохраняется; попадает в `GET /api/state`.

---

## Быстрый старт

```bash
# 1. (опционально) включить токен API
cp bundles/notGT/cfg/notGT.example.json \
   bundles/notGT/cfg/notGT.json
$EDITOR bundles/notGT/cfg/notGT.json

# 2. запустить NodeCG из корня репозитория
node index.js
```

Дальше:

- дашборд — `http://localhost:9090/dashboard/`
- графику подключить в OBS:
  `http://localhost:9090/bundles/notGT/graphics/out.html?out=main`

Сборка бандла (если правили `src/`):

```bash
cd bundles/notGT && npm install && npm run build && cd ../..
```

Про Docker-деплой см. `docker-compose.yml` и `.env.example` в корне репозитория.

---

## Дашборд: панели

Общий дашборд NodeCG — `http://<host>/dashboard/`. Файлы панелей бандла отдаются по
`/bundles/notGT/dashboard/<file>`.

Вкладки сверху — это workspaces NodeCG. **`notGT — Control`** и **`notGT — Editor`** —
каждая в своей вкладке (`fullbleed`), а `notGT — Titles & Outs` живёт в **MAIN WORKSPACE**
вместе с панелями других бандлов.

### notGT — Control (`control.html`) — своя вкладка

Операторская панель «здесь и сейчас»:

- **Программа** — выбор титра и out'а, `Показать` / `Скрыть` / `Переключить` /
  `Проиграть один раз`, необязательные per-show override'ы в JSON;
- **Данные (переменные)** — список переменных; для выбранной переменной справа
  редактируются её значения. Если значение — массив, это список значений, у которого
  можно пометить **текущий** элемент (именно он уходит в `{{...}}`), добавить значение,
  изменить, переставить или удалить элемент. Есть массовый ввод JSON (merge/replace);
- **Анимации на out'ах** — что размещено на каждом выходе: режим (`once`/`loop`), признак
  «играет», кнопка **`Проиграть`** (разовый проигрыш) и переключатель
  **«показать»** — это режим «показать и держать»: включили — размещение висит в эфире
  сколько нужно и не убирается по `holdMs`, выключили — скрылось. Он не зависит от
  `once`/`loop` и перекрывает `enabled`; соответствующий признак размещения — `held`;
- **Out'ы для OBS** — готовые ссылки для Browser Source с копированием в один клик.

Это панель для эфира: она не меняет вёрстку, только гоняет программу и данные.

### notGT — Titles & Outs (`titles.html`)

Конфигурация:

- CRUD по **анимациям** (templates): имя, размеры, переходы, playback;
- CRUD по **out'ам**: id, имя, размер сцены;
- **размещения**: поставить анимацию на out, задать `x`/`y`/`scale`/`order`/`enabled` и
  playback конкретного размещения;
- **копирование URL** out'а для вставки в OBS.

### notGT — Editor (`editor.html`)

Полноэкранный редактор **выбранного out'а**. Холст — это сцена out'а
(`out.width × out.height`): на нём сразу видно всё, что размещено на этом выходе, ровно
так, как это отрисует OBS.

- Селектор **`Out:`** переключает редактируемый выход; на холсте появляются все его
  размещения. Невыбранные анимации показываются приглушённо и по клику становятся
  активными.
- **Размещение** правится мышью: рамка активной анимации тянется (меняет `x`/`y` в % от
  сцены), угловая ручка — масштаб (`scale`); кнопка «по размеру out'а» ставит
  `scale = out.width / template.width`.
- **Слои** внутри анимации перетаскиваются и масштабируются как раньше; свойства
  (шрифт, цвет, обводка, тень, выравнивание и т.д.) правятся в инспекторе справа.
- **`+ Текст` / `+ Фигура` / `+ Картинка` / `+ GIF`** добавляют слой в активную анимацию.
  Если ни одна не выбрана — создаётся новая анимация по размеру out'а, размещается на нём
  и становится активной.
- Слева два списка: **«На этом out'е»** (размещения: порядок, вкл/выкл, проиграть,
  удалить, признак «играет») и **«Все анимации»** (библиотека шаблонов).
- Для шаблонов `kind: "code"` — **редактор кода** (HTML / CSS / JS) с живым превью;
  на холсте такая анимация показана рамкой-заглушкой, которую тоже можно двигать и
  масштабировать.
- Правки слоёв/шаблона сохраняются по кнопке **«Сохранить»** (индикатор «● не
  сохранено»); размещения применяются сразу, потому что перетаскивание терять нельзя.
- **`Preview`** проигрывает активную анимацию один раз, **`Показать` / `Toggle` /
  `Скрыть`** управляют эфиром на выбранном out'е, **`Копировать URL`** даёт ссылку для
  OBS Browser Source.

---

## Конфигурация бандла

NodeCG читает конфиг бандла из `bundles/notGT/cfg/notGT.json`; схема —
`bundles/notGT/configschema.json`. **Активного `notGT.json` в репозитории нет** —
сначала скопируйте пример:

```bash
cp bundles/notGT/cfg/notGT.example.json \
   bundles/notGT/cfg/notGT.json
```

| Ключ                       | Тип     | По умолчанию | Назначение                                                                                     |
| -------------------------- | ------- | ------------ | ---------------------------------------------------------------------------------------------- |
| `apiToken`                 | string  | `""`         | Общий секрет для `/api`. Пустая строка = API открыт.                                            |
| `allowUnauthenticatedApi`  | boolean | `false`      | Явно разрешить открытый API и заглушить предупреждение. Игнорируется, если `apiToken` задан.     |
| `hideApiState`             | boolean | `false`      | Убрать `templates`/`outs` из ответа `GET /api/state` (для частого polling'а из Companion).       |
| `defaultOutId`             | string  | `"main"`     | `id` out'а, который создаётся при первом запуске.                                                |

Конфиг читается один раз при старте бандла — **после правки перезапустите NodeCG**
(в Docker: `docker compose restart notgt`).

---

## REST API

Бандл монтирует один и тот же роутер по двум путям:

- `http://<host>/api` — короткий, удобный для Companion;
- `http://<host>/bundles/notGT/api` — версия с префиксом бандла (полезна за
  reverse-proxy, который режет путь).

Дальше в примерах используется короткий `/api`; заменяйте префикс, если нужен второй.

### Аутентификация

- Если `apiToken` **задан**, каждый запрос к `/api/*` должен принести токен одним из
  способов:
  - `Authorization: Bearer <token>`
  - `X-API-Token: <token>`
  - `?token=<token>`
- `GET /api/health` **всегда открыт** — чтобы uptime-пробы не нуждались в секрете.
- Если `apiToken` **пустой**, API открыт; при старте в лог пишется warning. Флаг
  `allowUnauthenticatedApi: true` этот warning глушит. Безопасная трактовка: пустой токен
  допустим только если сервер недоступен из недоверенных сетей или закрыт Basic Auth на
  уровне Traefik.
- Ответ без/с неверным токеном — `401 {"error":"unauthorized", ...}`.
- CORS открыт (`Access-Control-Allow-Origin: *`), поэтому опрашивать API можно прямо из
  браузера.

Во всех примерах ниже `$NOTGT_TOKEN` — значение `apiToken`, а `-H "Authorization: Bearer …"`
можно заменить на `-H "X-API-Token: …"` или `?token=…`.

### Эндпоинты

| Метод                | Путь                                        | Назначение                                                                                     |
| -------------------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| `GET`                | `/api/health`                               | Проверка живости. Всегда открыт.                                                                |
| `GET`                | `/api/state`                                | Агрегированное состояние программы (см. ниже).                                                  |
| `GET`                | `/api/data`                                 | Весь набор переменных.                                                                          |
| `GET`                | `/api/data?path=speaker.name`               | Одно значение по пути.                                                                          |
| `POST`               | `/api/data`                                 | Запись переменных. `?mode=merge` (по умолчанию) или `?mode=replace`.                             |
| `GET`                | `/api/data?path=guests&raw=1`               | Как выше, но вернуть узел как он хранится (массив), без резолва по выбранному элементу.          |
| `DELETE`             | `/api/data/:path`                           | Удалить значение по пути.                                                                       |
| `GET`                | `/api/selection`                            | Выбранный элемент для переменных-списков: `{"guests": 1}`.                                       |
| `POST`               | `/api/selection`                            | Выбрать элемент: `{"path": "guests", "index": 1}` (или сразу карта `{"guests": 1}`).             |
| `DELETE`             | `/api/selection/:path`                      | Сбросить выбор (вернётся элемент `0`).                                                           |
| `GET`                | `/api/templates`                            | Список анимаций.                                                                                |
| `POST`               | `/api/templates`                            | Создать анимацию.                                                                               |
| `GET` `PUT` `PATCH`  | `/api/templates/:id`                        | Прочитать / обновить анимацию (`PATCH` — частичное обновление).                                 |
| `DELETE`             | `/api/templates/:id`                        | Удалить анимацию.                                                                               |
| `POST`               | `/api/titles/:templateId/show`              | Показать анимацию.                                                                              |
| `POST`               | `/api/titles/:templateId/toggle`            | Показать/скрыть (toggle).                                                                       |
| `POST`               | `/api/titles/:templateId/trigger`           | Однократный проигрыш (one-shot).                                                                |
| `POST`               | `/api/titles/hide`                          | Скрыть титр.                                                                                    |
| `GET`                | `/api/outs`                                 | Список out'ов.                                                                                  |
| `POST`               | `/api/outs`                                 | Создать out.                                                                                    |
| `GET` `PUT` `PATCH`  | `/api/outs/:id`                             | Прочитать / обновить out.                                                                       |
| `DELETE`             | `/api/outs/:id`                             | Удалить out.                                                                                    |
| `GET`                | `/api/outs/:id/url`                         | URL для OBS Browser Source.                                                                     |
| `POST`               | `/api/outs/:outId/stop`                     | Остановить воспроизведение на out'е.                                                            |
| `POST`               | `/api/outs/:outId/items`                    | Добавить размещение на out (`{templateId, ...}`).                                               |
| `PUT` `PATCH`        | `/api/outs/:outId/items/:itemId`            | Обновить размещение.                                                                            |
| `DELETE`             | `/api/outs/:outId/items/:itemId`            | Удалить размещение.                                                                             |
| `POST`               | `/api/outs/:outId/items/:itemId/trigger`    | One-shot конкретного размещения (необязательный `{holdMs}`).                                    |

### `GET /api/state`

```json
{
  "active": {
    "templateId": "lower_third",
    "visible": true,
    "outId": "main",
    "data": {},
    "label": "Alice",
    "updatedAt": 1735000000000
  },
  "activeTemplateId": "lower_third",
  "activeVisible": true,
  "activeOutId": "main",
  "playing": { "main": ["item_ab12cd34ef56"] },
  "revision": 42,
  "outs": [{ "id": "main", "name": "Main", "width": 1920, "height": 1080, "url": "…" }],
  "templates": [{ "id": "lower_third", "name": "Lower third", "kind": "layers" }]
}
```

- `activeTemplateId`, `activeVisible`, `activeOutId` — «плоские» дубликаты полей `active`,
  чтобы в Companion можно было указать JSON path напрямую.
- `playing` — какие размещения реально играют сейчас, по out'ам.
- `revision` — монотонный счётчик: меняется при любом изменении, удобен для дешёвого
  определения «что-то поменялось».
- `outs` и `templates` **отсутствуют**, если `hideApiState: true`.

### Примеры

Проверка живости (токен не нужен):

```bash
curl -sS http://<host>/api/health
```

Состояние программы:

```bash
curl -sS http://<host>/api/state \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

Переменные: целиком, по пути и запись.

```bash
curl -sS http://<host>/api/data -H "Authorization: Bearer $NOTGT_TOKEN"

curl -sS 'http://<host>/api/data?path=speaker.name' \
  -H "Authorization: Bearer $NOTGT_TOKEN"

# merge (по умолчанию): точечно обновляет переданные ключи
curl -sS -X POST 'http://<host>/api/data?mode=merge' \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"speaker":{"name":"Alice","role":"Host"}}'

# replace: заменяет весь набор переменных переданным объектом
curl -sS -X POST 'http://<host>/api/data?mode=replace' \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"data":{"speaker":{"name":"Alice"}}}'

curl -sS -X DELETE 'http://<host>/api/data/speaker.name' \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

> Тело `POST /api/data` — это либо сам объект данных, либо обёртка `{"data": {…}}`;
> работает и так, и так.

Показать титр (вариант для Companion и для внешних систем):

```bash
# тело целиком считается override'ом переменных…
curl -sS -X POST http://<host>/api/titles/lower_third/show \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"speaker":{"name":"Alice"}}'

# …либо override лежит в `data`, а out/label — рядом
curl -sS -X POST http://<host>/api/titles/lower_third/show \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"out":"main","label":"Alice","data":{"speaker":{"name":"Alice"}}}'

# то же самое через query-параметры
curl -sS -X POST 'http://<host>/api/titles/lower_third/show?out=main&label=Alice' \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

Toggle, one-shot trigger и скрытие:

```bash
curl -sS -X POST http://<host>/api/titles/lower_third/toggle \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main"}'

# trigger: играет один раз. Если анимация уже размещена на out'е — играет размещение,
# иначе она показывается на holdMs и скрывается сама.
curl -sS -X POST http://<host>/api/titles/lower_third/trigger \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main","holdMs":5000}'

# hide: остановить воспроизведение на конкретном out'е…
curl -sS -X POST http://<host>/api/titles/hide \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main"}'

# …или на всех сразу
curl -sS -X POST http://<host>/api/titles/hide \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{}'

# templateId сужает скрытие до конкретного титра, out — до конкретного выхода
curl -sS -X POST http://<host>/api/titles/hide \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"out":"main","templateId":"lower_third"}'
```

> `POST /api/titles/hide` принимает `{out?, templateId?}`. Скрытие активного титра
> срабатывает, только если он подходит под переданные фильтры. Если `templateId` не
> передан, дополнительно останавливается воспроизведение на указанном out'е (или на всех,
> если `out` не передан).

Анимации (templates):

```bash
curl -sS -X POST http://<host>/api/templates \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "id": "lower_third",
        "name": "Lower third",
        "kind": "layers",
        "width": 1920,
        "height": 1080,
        "layers": [
          {
            "id": "name",
            "type": "text",
            "x": 6, "y": 78, "width": 60,
            "binding": "speaker.name",
            "style": { "fontFamily": "Inter", "fontSize": 64, "color": "#ffffff" },
            "z": 1
          }
        ],
        "inTransition": { "type": "slide-left", "durationMs": 350 },
        "outTransition": { "type": "fade", "durationMs": 250 },
        "playback": { "mode": "loop", "intervalMs": 30000, "holdMs": 8000, "autoStart": false }
      }'

curl -sS http://<host>/api/templates/lower_third -H "Authorization: Bearer $NOTGT_TOKEN"

curl -sS -X PATCH http://<host>/api/templates/lower_third \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"playback":{"mode":"once"}}'

curl -sS -X DELETE http://<host>/api/templates/lower_third \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

Для `POST /api/templates` обязателен `name` (иначе `400`); `id` можно не указывать —
он будет выведен из `name`. Для `POST /api/outs` повторяющийся `id` даёт `409`.

Outs и размещения:

```bash
curl -sS http://<host>/api/outs -H "Authorization: Bearer $NOTGT_TOKEN"

curl -sS -X POST http://<host>/api/outs \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"id":"interview","name":"Interview","width":1920,"height":1080}'

# URL для OBS
curl -sS http://<host>/api/outs/interview/url -H "Authorization: Bearer $NOTGT_TOKEN"

# поставить анимацию на out
curl -sS -X POST http://<host>/api/outs/interview/items \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{
        "templateId": "lower_third",
        "x": 0, "y": 0, "scale": 1,
        "playback": { "mode": "loop", "intervalMs": 30000, "holdMs": 8000, "autoStart": true }
      }'

# one-shot конкретного размещения
curl -sS -X POST http://<host>/api/outs/interview/items/item_ab12cd34ef56/trigger \
  -H "Authorization: Bearer $NOTGT_TOKEN" \
  -H 'Content-Type: application/json' -d '{"holdMs":6000}'

# остановить всё на out'е
curl -sS -X POST http://<host>/api/outs/interview/stop \
  -H "Authorization: Bearer $NOTGT_TOKEN"
```

---

## Bitfocus Companion

Полноценного модуля для Companion в поставке нет — используется штатный HTTP-модуль.
Это покрывает 95 % задач: показать титр, скрыть, подсветить кнопку по состоянию.

### Подключение

Создайте в Companion connection типа HTTP-запросов (например, **Generic HTTP Requests**),
укажите базовый адрес:

```
http://<host>
```

и добавьте заголовок с токеном (если `apiToken` задан):

```
X-API-Token: <token>
```

или

```
Authorization: Bearer <token>
```

Проверка связи: `GET /api/health` должен отвечать `{"ok":true,...}` — этот путь открыт
всегда, токен ему не нужен.

### Действия (actions)

**Показать титр:**

- Method: `POST`
- URL / path: `/api/titles/<templateId>/show`
- Body (JSON, опционально): `{"out":"main"}` или `{"out":"main","label":"Alice"}`
- Content-Type: `application/json`

Например, для шаблона `lower_third`:

```
POST /api/titles/lower_third/show   {"out":"main"}
```

**Скрыть титр:**

```
POST /api/titles/hide   {}
```

или на конкретном out'е:

```
POST /api/titles/hide   {"out":"main"}
```

Дополнительно теми же средствами доступны `toggle` и `trigger`:

```
POST /api/titles/<templateId>/toggle    {"out":"main"}
POST /api/titles/<templateId>/trigger   {"out":"main","holdMs":5000}
```

`trigger` — однократный проигрыш; если анимация размещена на out'е, играет размещение,
иначе она показывается на `holdMs` и скрывается сама.

Эквивалент в curl (удобно проверить до настройки Companion):

```bash
curl -sS -X POST http://<host>/api/titles/lower_third/show \
  -H "X-API-Token: $NOTGT_TOKEN" -H 'Content-Type: application/json' -d '{"out":"main"}'
```

### HTTP Feedback (подсветка кнопки)

Companion умеет опрашивать URL и доставать значение по JSON path — на это вешается
feedback «кнопка горит, когда…».

- URL: `http://<host>/api/state`
- Header: `X-API-Token: <token>`
- Метод: `GET`
- Poll interval: **500 ms** (рекомендуется)
- JSON path — строка, которую вы вписываете в поле feedback'а:

| JSON path              | Пример значения              | Что означает                                                       |
| ---------------------- | ---------------------------- | ------------------------------------------------------------------ |
| `activeVisible`        | `true` / `false`             | Показан ли сейчас какой-либо титр.                                  |
| `activeTemplateId`     | `"lower_third"` / `null`     | `id` текущего шаблона (или `null`, если ничего не показано).        |
| `activeOutId`          | `"main"` / `null`            | На каком out'е показ (`null` = на всех).                            |
| `revision`             | `42`                         | Счётчик изменений — удобно для «мигнуть при любом изменении».        |
| `playing.main[0]`      | `"item_ab12cd34ef56"`        | Первое играющее размещение на out'е `main` (ключа может не быть).   |

Типовые настройки кнопки:

- **Show / Hide** — две кнопки с действиями `show` и `hide`, обе подсвечиваются от
  `activeVisible` (или от `activeTemplateId`, если кнопок много и каждая про свой шаблон).
- **Trigger** — кнопка с одним действием `trigger`, подсветка от `playing.main[0]`
  (пока размещение играет, значение непустое).

Замечания:

- Каждый feedback — это отдельный HTTP-запрос на каждый poll. При 500 ms это нормально,
  но если кнопок много, включите `hideApiState: true` в конфиге бандла: из ответа уйдут
  массивы `outs` и `templates`, а все пути из таблицы выше продолжат работать.
- `outId` — это slug (`[a-z0-9-]`), поэтому `playing.main[0]` корректен; точки в `outId`
  не встречаются by design.
- 500 ms — компромисс между отзывчивостью кнопки и нагрузкой. Для «дисплейных» кнопок,
  которым не нужна мгновенная реакция, можно поставить 1000–2000 ms; меньше 250 ms смысла
  не имеет, состояние всё равно пересчитывается на сервере.

### Перспектива: собственный модуль

Если позже понадобится push вместо polling'а, правильный путь — отдельный модуль
Companion на `@companion-module/base`, который подключается к NodeCG по **Socket.IO** и
подписывается на Replicant'ы напрямую. Это даёт:

- обновления состояния без polling'а (сервер сам присылает изменения);
- динамические выпадающие списки шаблонов и out'ов в actions (вместо ручного ввода id);
- готовые variables/feedbacks с нормальными именами.

Сейчас это не реализовано; HTTP-схема выше — рекомендуемый способ.

---

## OBS Studio

1. **Источники → Добавить → Browser**.
2. **URL**:

   ```
   http://<host>/bundles/notGT/graphics/out.html?out=main
   ```

3. **Width / Height** — размер сцены этого out'а (по умолчанию `1920` × `1080`).
   Держите их равными `width`/`height` из панели «Titles & Outs», иначе поплывёт масштаб.
4. **Shutdown source when not visible** — **выключено**. Иначе браузер-сорс выгружается,
   теряет соединение и на повторном появлении сцены показывает устаревшее состояние.
5. **Background** — ничего настраивать не нужно: страница прозрачная (`html, body` имеют
   прозрачный фон), OBS берёт её как есть.
6. Обновите источник **один раз** после создания — дальше он живёт сам.

### Диагностический оверлей

Добавьте в URL флаг `debug`:

```
http://<host>/bundles/notGT/graphics/out.html?out=main&debug=1
```

Оверлей в углу страницы показывает: `out`, `revision`, список играющих размещений и
список активных слотов. Он обновляется раз в секунду даже в простое, поэтому в эфире его
лучше не держать — включайте только для отладки.

### Несколько выходов

Несколько Browser Source'ов с разными `?out=` работают одновременно и независимо:

```
http://<host>/bundles/notGT/graphics/out.html?out=main
http://<host>/bundles/notGT/graphics/out.html?out=interview
```

### Чего делать не нужно

**Не перезагружайте Browser Source при изменении данных.** Переменные, список playing и
правки шаблонов приходят на страницу сами (через Replicant'ы и Socket.IO). Reload только
рвёт соединение и заново проигрывает входную анимацию; при `{{...}}` в code-шаблоне он ещё
и пересобирает iframe. Если кажется, что «не обновляется» — сначала посмотрите на оверлей
`&debug=1` и на `GET /api/state`.

---

## Персистентность

NodeCG хранит Replicant'ы в `db/` (в Docker — в томе `notgt-db`). Что это значит на
практике.

### Переживает перезапуск

- **Анимации (templates)** — это Replicant, включая слои, переходы и playback.
- **Outs** — включая все размещения с их координатами, scale и playback.
- **Переменные (titleData)** — все значения, введённые в панели Control или через API.
- **Последнее состояние программы (activeTitle)** — что было показано, на каком out'е,
  с каким label и override'ами.
- **Служебные метаданные (meta)** — например, факт первичной инициализации.
- **Загруженные ассеты** (категория `media`) — лежат в `assets/` (в Docker — том
  `notgt-assets`).

### Не переживает перезапуск

- **Производное состояние воспроизведения** (`runtime`: `playing`, `revision`) —
  пересчитывается на сервере заново.
- **Запущенные таймеры** — интервалы и `setTimeout` живут только в процессе. Одиночные
  триггеры «в полёте» теряются; циклы (`mode: "loop"`) с `autoStart: true` планировщик
  поднимет автоматически при старте.

В Docker-развёртывании `db`, `assets` и `logs` — это volumes, объявленные в
`docker-compose.yml`; они переживают `docker compose down` и пересборку образа. Если
удалить volume — конфигурация шоу пропадёт.

---

## Написание code-анимации

Шаблон `kind: "code"` состоит из трёх строк: `code.html`, `code.css`, `code.js`. Он
исполняется в sandboxed iframe (`sandbox="allow-scripts allow-same-origin"`), который
живёт внутри слота анимации.

### Контракт рантайма

Внутри iframe доступны:

| Сущность                   | Что это                                                                                       |
| -------------------------- | --------------------------------------------------------------------------------------------- |
| `root`                     | Контейнер анимации — это `document.body`.                                                      |
| `data`                     | Весь набор переменных (объект) на момент создания iframe; обновляется при изменениях.          |
| `vars(path, fallback?)`    | Прочитать одно значение по пути. Возвращает строку; `fallback` — если значение пустое.         |
| `onData(fn)`               | Подписка: `fn` вызывается сразу с текущими данными и затем на каждое изменение.                |
| `[data-bind="path"]`       | Текстовые узлы с этим атрибутом обновляются автоматически при каждом изменении данных.         |
| `{{path}}` в HTML и CSS    | Подстановка значения **один раз при загрузке** (не живая).                                     |

Правила:

- `{{path}}` и `{{path ?? fallback}}` работают **только в HTML и CSS**. В `code.js`
  подстановки нет — для живых значений используйте `vars()` / `onData()` / `[data-bind]`.
- Пути точечные, с индексами массивов: `speaker.name`, `panel.items[0].title`.
- Iframe **пересобирается заново** при изменении самого шаблона (правки кода, слоёв,
  размеров), а не при изменении данных: при правке кода `{{...}}` пересчитается, входная
  анимация проиграется снова. Изменения данных приходят через `postMessage` и `onData`,
  без перезагрузки.
- `vars()` всегда возвращает строку. Объекты сериализуются в JSON, `null`/`undefined`
  дают пустую строку.

### Анимации из файлов (без веб-редактора)

Анимацию можно написать не в панели Editor, а файлом. Положите `.html` в
`bundles/notGT/graphics/animations/` — при старте extension зарегистрирует каждый файл
как шаблон `kind: "code"` с id `file-<имя-файла>` и `code.src`, указывающим на этот файл.
Готовый пример — `graphics/animations/example-file-animation.html`.

```bash
cp my-animation.html bundles/notGT/graphics/animations/
curl -X POST http://localhost:9090/api/animations/sync      # перечитать каталог
curl http://localhost:9090/api/animations                   # что зарегистрировано
```

Правила для файловых анимаций:

- Рантайм (`vars`, `data`, `onData`, `root`, `[data-bind]`) подключается автоматически
  **до** ваших `<script>`, поэтому `onData(...)` можно вызывать сразу.
- `{{path}}` / `{{path ?? fallback}}` подставляются и в файле — везде, **кроме**
  содержимого `<script>` (JS никогда не переписывается; для живых значений в JS
  используйте `vars()` / `onData()`).
- Относительные пути к картинкам и шрифтам работают: страница собирается с `<base>`,
  указывающим на каталог файла.
- Файл перечитывается при пересборке iframe, то есть при показе анимации или после
  правки шаблона. Перезапуск NodeCG для правки файла не нужен — достаточно заново
  показать анимацию (или обновить Browser Source в OBS).
- Если открыть такую анимацию в панели Editor и ввести HTML в поле `code.html`, инлайн-код
  начинает иметь приоритет над файлом (своего рода «fork»). Чтобы вернуться к файлу,
  очистите `code.html`.

### Пример

`code.html`:

```html
<div class="card">
  <div class="name" data-bind="speaker.name">—</div>
  <div class="role">{{speaker.role ?? Guest}}</div>
</div>
```

`code.css`:

```css
.card {
  position: absolute;
  left: 6%;
  bottom: 8%;
  padding: 24px 40px;
  background: {{panel.color ?? #1d2b3a}};
  border-radius: 12px;
  font-family: Inter, system-ui, sans-serif;
  color: #fff;
}
.name {
  font-size: 64px;
  font-weight: 700;
}
.role {
  font-size: 32px;
  opacity: 0.8;
}
```

`code.js`:

```js
const el = root.querySelector(".name");

onData((d) => {
  // живое значение вместо {{...}}
  const role = vars("speaker.role", "Guest");
  root.querySelector(".role").textContent = role;
});

// начальная анимация — свойство самого iframe, но можно и так:
el.animate([{ opacity: 0, transform: "translateY(20px)" }, { opacity: 1 }], {
  duration: 350,
  easing: "ease-out",
});
```

`[data-bind="speaker.name"]` в HTML обновляется рантаймом, поэтому в JS его трогать не
нужно.

---

## Alpha-видео в оверлеях

**`.mov` с alpha (ProRes 4444, HEVC+alpha, Animation) в Browser Source не играет
вообще** — Chromium не умеет ни ProRes, ни alpha в H.264, поэтому такой файл не
запустится независимо от размера. Нужна конвертация.

Проверено отрисовкой в Chromium (тот же движок, что в OBS Browser Source):

| Формат | Alpha | Куда ставить |
| --- | --- | --- |
| animated **WebP** | работает | слой `gif` или `image` (это просто `<img>`) |
| **WebM VP9** + alpha | работает | слой `video` |
| **WebM VP8** + alpha | работает | слой `video` |
| ProRes 4444 `.mov` | **не декодируется** | — |

### Перетаскивание прямо в редакторе

В панели **Editor**, в секции слоя **«ВИДЕО»**, файл можно просто перетащить
(или выбрать кликом):

- `.webm`, `.webp`, `.gif`, `.png`, `.apng`, `.jpg`, `.svg` — публикуются **как есть**;
- всё остальное (`.mov`, `.mp4`, `.mkv`, `.avi`, ProRes/HEVC с alpha) — сервер сам
  конвертирует, показывая **два прогресс-бара**: «Загрузка» (реальный прогресс отправки)
  и «Конвертация» (реальный прогресс ffmpeg). По завершении `src` слоя подставляется
  автоматически, остаётся нажать «Сохранить».

Результат складывается в **`<runtimeRoot>/assets/notGT/media/`** и отдаётся как
`/assets/notGT/media/<файл>`. В Docker это том `assets`, то есть загруженное
**переживает пересборку контейнера** (в отличие от `graphics/media/`, который попадает
в образ). Каталог переопределяется ключом `mediaDir` в конфиге бандла. Ограничение
загрузки — 2 ГБ.

Рядом со зоной drop есть список «уже загружено» (из `GET /bundles/notGT/media/list`),
чтобы переиспользовать файл или удалить его.

**Нужен ffmpeg на сервере.** Dockerfile его ставит (`--build-arg INSTALL_FFMPEG=false`,
если не нужен). Без ffmpeg загрузка готовых `.webm`/`.webp` продолжает работать, а
попытка конвертации вернёт понятную ошибку с подсказкой.

Эндпоинты (защищены сессией NodeCG, токен API им не нужен):

| Метод | Путь | Назначение |
| --- | --- | --- |
| `POST` | `/bundles/notGT/media/upload?name=<имя>` | тело — сырые байты файла; ответ `{jobId}` |
| `GET` | `/bundles/notGT/media/jobs/:id` | состояние и прогресс задачи |
| `GET` | `/bundles/notGT/media/list` | уже загруженные файлы |
| `DELETE` | `/bundles/notGT/media/file/:name` | удалить файл |

### Конвертер

```bash
cd bundles/notGT

# короткий луп (<= 10 c) -> animated WebP, с автообрезкой содержимого
node scripts/convert-alpha.mjs ~/overlay.mov

# длиннее -> WebM VP9
node scripts/convert-alpha.mjs ~/overlay.mov --format webm

# уменьшить и поджать
node scripts/convert-alpha.mjs ~/overlay.mov --format webm --max-width 960 --crf 34

# посмотреть команды, ничего не запуская
node scripts/convert-alpha.mjs ~/overlay.mov --dry-run
```

Что делает: читает параметры через `ffprobe`, проверяет наличие alpha, ищет реальный
бокс содержимого (`cropdetect`) и обрезает по нему, при необходимости масштабирует и
пересчитывает fps, выбирает формат по длительности (`--threshold`, по умолчанию 10 c),
а потом печатает выигрыш по размеру и готовый `src` для слоя. Результат попадает в
`graphics/media/` и отдаётся как `/bundles/notGT/graphics/media/<файл>`.

Ключевые опции: `--format auto|webp|webm|webm-vp8`, `--out <dir>`, `--quality` (WebP),
`--crf` (VP8/VP9), `--bitrate` (VP8), `--fps`, `--scale w:h`, `--max-width`,
`--crop w:h:x:y`, `--no-crop`, `--dry-run`.

### Если хочется своими руками

```bash
# animated WebP (короткие лупы)
ffmpeg -i in.mov -c:v libwebp_anim -pix_fmt yuva420p -q:v 80 -loop 0 -an out.webp

# WebM VP9 (длиннее). -auto-alt-ref 0 обязателен: без него libvpx
# вообще отказывается кодировать прозрачность
ffmpeg -i in.mov -c:v libvpx-vp9 -pix_fmt yuva420p -auto-alt-ref 0 \
  -b:v 0 -crf 30 -row-mt 1 -cpu-used 2 -an out.webm

# автообрезка по содержимому — самый крупный выигрыш
CROP=$(ffmpeg -i in.mov -vf cropdetect=limit=0.1:round=2 -frames:v 90 -f null - 2>&1 \
       | grep -o 'crop=[0-9:]*' | tail -1)
```

### Грабля с проверкой alpha

**Не проверяйте прозрачность WebM через `ffprobe`/`ffmpeg`.** В WebM alpha лежит
отдельным auxiliary-планом, и ffmpeg-декод его не показывает — файл выглядит
непрозрачным, хотя Chromium/OBS проигрывают его с alpha корректно. Проверять нужно
в OBS (или в Chromium). Для WebP такой проблемы нет, и конвертер сам проверяет alpha.

---

## Траблшутинг

**`401 {"error":"unauthorized"}`.** Задан `apiToken`, а запрос идёт без него. Добавьте
`Authorization: Bearer <token>`, `X-API-Token: <token>` или `?token=<token>`. Проверьте,
что в конфиге нет лишних пробелов в токене.

**В логе предупреждение, что API открыт.** `apiToken` пустой. Задайте токен в
`bundles/notGT/cfg/notGT.json` и перезапустите NodeCG — либо закройте API Basic
Auth'ом на уровне Traefik (см. `docker-compose.yml`).

**На графике пусто.** Проверьте по порядку: out существует (панель «Titles & Outs») →
URL содержит правильный `?out=` → у размещения `enabled: true` → анимация реально
показывается или играет (в `GET /api/state` это `activeVisible` / `playing`).
Включите `&debug=1`.

**В консоли страницы `No out matching "…"`.** В URL `?out=` указан id, которого нет.
Создайте out с таким id или поправьте URL.

**Данные не появляются на графике.** Не перезагружайте Browser Source: значения приходят
через Replicant'ы. Убедитесь, что путь в `{{...}}`/`binding`/`data-bind` совпадает с
ключом в `GET /api/data` (регистр и вложенность важны).

**Правка конфига не применилась.** Конфиг читается при старте — перезапустите NodeCG
(`docker compose restart notgt`).

**Companion не подсвечивает кнопку.** Проверьте, что feedback опрашивает `/api/state`
(а не `/api/health`), что указан `X-API-Token` и что JSON path написан точно как в
таблице выше (`activeVisible`, а не `active.visible`). Убедитесь, что между Companion и
сервером нет Basic Auth, который возвращает `401`.

**Не сохранилось после пересоздания контейнера.** Проверьте, что в `docker-compose.yml`
на месте volumes для `/opt/nodecg/db` и `/opt/nodecg/assets`. Без них каждый новый
контейнер стартует с чистого состояния.

**Логи.** Панель NodeCG или консоль процесса; в Docker —

```bash
docker compose logs -f notgt
```

Либо файлы в `logs/` (в Docker — том `notgt-logs`).

---

## Проверка (smoke-тесты)

В бандле есть два headless-теста на Puppeteer, которые проверяют критерии приёмки
без OBS. NodeCG должен быть уже запущен на `127.0.0.1:9090` (адрес переопределяется
через `NOTGT_BASE`, путь к Chromium — через `CHROME_PATH`).

```bash
cd bundles/notGT
npm run test:e2e
```

Что проверяет `scripts/e2e-out.mjs` (графика):

- фон страницы полностью прозрачный (`rgba(0, 0, 0, 0)`),
- `POST /api/titles/<id>/show` выводит титр **менее чем за 500 мс**,
- текст слоя соответствует значению переменной, включая подстановку `{{...}}`,
- `POST /api/data` меняет текст на экране **без перезагрузки страницы** — JS-контекст
  и сам DOM-узел сохраняются (проверка «без мигания»),
- code-анимация рендерится в своём sandbox-iframe и видит `vars()`/`data`,
- loop-размещение с `autoStart` действительно играет, гаснет после `holdMs` и
  останавливается при удалении.

Что проверяет `scripts/e2e-panels.mjs` (дашборд): все три панели монтируются в
standalone-режиме, не дают ошибок в консоли, а в редакторе присутствует Konva-canvas.

Скриншоты складываются в `bundles/notGT/.e2e/` (каталог в `.gitignore`).
