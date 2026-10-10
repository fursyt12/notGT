# NodeCG

[English](README.md) · **Русский**

[![NodeCG](https://raw.githubusercontent.com/nodecg/nodecg/main/media/splash.png)](https://nodecg.dev/)

[![Discord](https://img.shields.io/discord/754749209722486814)](https://discord.gg/nsXXDFGBEt)
[![Build Status](https://github.com/hoishin/nodecg/workflows/CI/badge.svg)](https://github.com/hoishin/nodecg/actions?query=workflow%3ACI)
[![Coverage Status](https://codecov.io/gh/nodecg/nodecg/branch/main/graph/badge.svg)](https://codecov.io/gh/nodecg/nodecg)
[![Docker Build Status](https://ghcr-badge.egpl.dev/nodecg/nodecg/latest_tag)](https://ghcr.io/nodecg/nodecg)

NodeCG — это фреймворк и приложение для эфирной графики. Он позволяет писать сложную динамическую графику для трансляций на веб-платформе. Собственных графических примитивов у NodeCG нет. Вместо этого он даёт структуру для вашего кода и API, который переносит данные между дашбордом, сервером и графикой. Он почти ничего не предписывает в том, как писать графику, и оставляет свободу в выборе библиотек, фреймворков, инструментов и подходов. Поэтому графика NodeCG отрисовывается в любой среде, которая умеет показывать HTML, в том числе:

- [OBS Studio](https://obsproject.com/)
- [vMix](http://www.vmix.com/)
- [XSplit](https://www.xsplit.com/)
- [CasparCG](https://github.com/CasparCG/server/releases) (v2.2.0+)

> Не нашли в списке свою программу для стриминга? Графике NodeCG нужен современный браузерный движок. Если browser source вашей программы построен на достаточно свежем движке, графика NodeCG, скорее всего, в нём заработает. Узнать версию движка можно, открыв [whatversion.net/chrome](https://www.whatversion.net/browser/) как browser source.

Есть вопросы о NodeCG или просто хочется поздороваться? [Заходите на наш сервер в Discord](https://discord.gg/nsXXDFGBEt)!

## notGT

В этом форке работает бандл титров и эфирной анимации **`notGT`** (название проекта — **notGT**).
Он добавляет несколько независимых графических выходов (`out.html?out=<id>`, по одному Browser
Source в OBS на каждый), набор анимаций — собранных из примитивов (текст / картинка / gif /
фигура) или написанных на HTML/CSS/JS — и REST API для дашборда, Bitfocus Companion и других
интеграций.

Руководство оператора — ментальная модель, панели дашборда, полный справочник REST API,
настройка OBS и Companion, персистентность и траблшутинг — лежит в
**[`bundles/notGT/README_RU.md`](bundles/notGT/README_RU.md)** (русский) и
**[`bundles/notGT/README.md`](bundles/notGT/README.md)** (English). Сам дашборд тоже на двух
языках: переключается кнопкой `EN` / `RU` в любой панели.

Чтобы написать новый титр с помощью LLM, в бандле есть файлы-промпты, в которых уже описан
контракт рантайма: **[`GENERATE_TITLES_RU.md`](GENERATE_TITLES_RU.md)** (русский) и
**[`GENERATE_TITLES.md`](GENERATE_TITLES.md)** (English). Заполните вводные в конце и
вставьте промпт в чат — получите `html` / `css` / `js` для шаблона `kind: "code"`.
Библиотека с первого запуска содержит одиннадцать готовых примеров в одном стиле, собранных
и из слоёв, и из кода (счёт матча, плашки с именем, опрос, бегущая строка, обратный отсчёт и
другие), а галерея в дашборде добавляет свежую копию любого из них.

Сборка и локальный запуск (бандл **не** входит в npm-workspaces этого монорепозитория,
поэтому у него свой `node_modules`, и ставится и собирается он отдельно):

```bash
npm ci
npm run build
cd bundles/notGT && npm install && npm run build && cd ../..
node index.js      # http://localhost:9090/dashboard/
```

В контейнере `docker-compose.yml` из корня репозитория сам публикует порт — ни reverse proxy,
ни `.env` не нужны:

```bash
docker compose up --build -d      # http://localhost:9090/dashboard/
```

Задайте `NOTGT_PORT` в `.env` (скопируйте `.env.example`), чтобы опубликовать другой порт, и
посмотрите на закомментированный блок TRAEFIK в compose-файле, если перед сервисом нужны имя
хоста, TLS и Basic Auth.

Образ ставит зависимости трижды (монорепозиторий, бандл, только production), поэтому первая
сборка идёт несколько минут и требует пары гигабайт временного места. Если она падает на шаге
`npm ci`, читайте строки _выше_ сообщения npm `Exit handler never called!`: это сообщение —
хвост падения npm, а строка над ним обычно `npm error network read ETIMEDOUT` — чтение из
реестра оборвалось по таймауту посреди установки, и Dockerfile уже повторяет его пять раз.

```bash
docker compose build --progress=plain 2>&1 | tail -60
```

Если реестр работает медленно или фильтруется в вашей сети, собирайте через зеркало, ничего не
редактируя:

```bash
NPM_REGISTRY=https://registry.npmmirror.com docker compose build
```

В Docker Desktop простое падение `npm ci` может также означать, что виртуальной машине не
хватило памяти или диска (проверить — `docker system df`, поднять лимит — Settings →
Resources); образ фиксирует версию npm и сам чистит свой кэш, чтобы слои оставались
небольшими.

## Windows

Портативную сборку для Windows делает
[`scripts/build-windows.mjs`](scripts/build-windows.mjs): он собирает `dist/notGT-win-x64/`
(встроенный рантайм Node.js, NodeCG, собранный бандл `notGT`, лаунчер) и
`dist/notGT-win-x64.zip`. На целевой машине ничего устанавливать не нужно.

```powershell
node scripts/build-windows.mjs --node-version 22.14.0
```

Распакуйте zip и запустите `notGT Launcher.exe` (или `notGT.cmd`, если `.exe` не собирался).
Лаунчер выбирает сетевой интерфейс и порт, запускает NodeCG и открывает дашборд. URL для
Browser Source в OBS:

```
http://<host>:<port>/bundles/notGT/graphics/out.html?out=main
```

Состояние хранится в `app\cfg`, `app\db` и `app\assets`. CI здесь только под Windows: каждый
push в `main` собирает пакет на `windows-latest` (только артефакт), а тег `v*` публикует его
как GitHub Release. Полная структура, флаги и процесс релиза — в
[`docs/windows-build.md`](docs/windows-build.md).

## Документация и справочник API

Полная документация и справочник API — на https://nodecg.dev

## Разработка

Чтобы участвовать в разработке NodeCG:

```bash
# Клонировать репозиторий
git clone https://github.com/nodecg/nodecg.git
cd nodecg

# Установить зависимости
npm install

# Пересборка и проверка типов при изменении файлов
npm run dev

# Собрать все пакеты workspace
npm run build

# Запустить тесты
npx vitest run

# Запустить NodeCG
npm start
```

Подробнее о вкладе в ядро NodeCG — в [руководстве для контрибьюторов на сайте документации](https://nodecg.dev/docs/working-on-nodecg-core)

## Цели

Проект NodeCG существует ради следующих целей:

- Сделать эфирную графику (её ещё называют «character generation», или «CG») доступнее.
- Оставаться как можно ближе к веб-платформе.
- Поддерживать трансляции любого масштаба и амбиций.

Разберём, что стоит за этими утверждениями:

### > Сделать эфирную графику (её ещё называют «character generation», или «CG») доступнее

Исторически эфирная графика была дорогой. Ей требовалось дорогое железо, дорогой софт или и то и другое. NodeCG изначально создавался, чтобы давать графику в реальном времени для Tip of the Hats — благотворительного марафона, который целиком держится на волонтёрах и первые несколько лет имел бюджет в \$0.

Сегодня амбициозную трансляцию можно собрать целиком на бесплатном софте и потребительском железе. Проект NodeCG поддерживает эту демократизацию эфирных технологий.

### > Оставаться как можно ближе к веб-платформе

Графика NodeCG — это просто веб-страницы. В них нет абсолютно ничего особенного или уникального. В этом их главная сила.

Опираясь на веб-платформу и не надстраивая над ней лишних абстракций, те, кто делает эфирную графику на NodeCG, получают доступ ко всему потенциалу веба. В веб-платформу постоянно добавляются новые API и возможности, и разработчикам на NodeCG должно быть доступно всё, что веб может предложить.

### > Поддерживать трансляции любого масштаба и амбиций

NodeCG вырос из маленьких трансляций без бюджета. В последнее время его всё чаще используют во всё более сложных постановках. Мы считаем, что один набор инструментов может и должен масштабироваться от самого маленького шоу до самого большого, какое только можно вообразить. Делаете ли вы всё в OBS или работаете с аппаратным микшером и классической схемой key/fill — NodeCG может быть частью любой системы эфирной графики.

## Мейнтейнеры

- [Matt "Bluee" McNamara](https://mattmcn.com/)
- [Keiichiro "Hoishin" Amemiya](https://twitter.com/hoishinxii)

## Дизайнеры

- [Chris Hanel](http://www.chrishanel.com)

## Благодарности

- [Atmo](https://github.com/atmosfar) — исходная концепция и код дашборда, вдохновение для toth-overlay
- [Alex "Lange" Van Camp](https://github.com/alvancamp) — дизайнер и разработчик [toth-overlay](https://github.com/TipoftheHats/toth-overlay), основы, на которой построен NodeCG
