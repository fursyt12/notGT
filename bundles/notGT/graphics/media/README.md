# graphics/media

Сюда `scripts/convert-alpha.mjs` складывает сконвертированные оверлеи. Файлы
отдаются NodeCG напрямую, без дополнительной настройки:

```
/bundles/notGT/graphics/media/<файл>
```

Пример:

```bash
cd bundles/notGT
node scripts/convert-alpha.mjs ~/overlay.mov
```

Что реально играет в OBS Browser Source:

- **animated WebP** (слой `gif` или `image`, либо `<img>` в code-анимации);
- **WebM VP8/VP9 с alpha** (слой `video`, либо `<video>` в code-анимации).

ProRes 4444 / HEVC+alpha `.mov` в Browser Source не играет вообще — Chromium
их не декодирует. Подробности — в README бандла, раздел «Alpha-видео».
