# Офлайн-измерители движения и аудит «ложно свободного пути» — 9 ноября 2026

**Сделаны две вещи: измерители положения машины/камеры с честной неопределённостью и инструмент разбора, где маска называет «свободным» то, что человек отметил как бордюр, столб, стоящую машину или закрытый обзор.**

Ни один измеритель здесь не выдаёт градусы или метры: масштаб не проверен, поэтому всё остаётся в долях кадра и пикселях. На живой GTA и на реальных записях ничего не запускалось — моделей (`packages/perception/models/`) и записей в этом окружении нет. Все числа ниже синтетические и помечены как development.

## 1. Измерители движения (пункт 4)

`packages/perception/ego-motion.mjs`.

- `roadRowProfile(p,{top,bottom})` берёт горизонтальную полосу дорожной маски и возвращает профиль по столбцам. Отказы явные: `invalid_road_mask` (маска не того размера), `invalid_band` (полоса уже 0.03 кадра — мерить нечего), `no_road_in_band`.
- `estimateShift(prev,cur,…)` — нормированная взаимная корреляция профилей. Возвращает `shift_pixels`, `shift_fraction`, `peak`, `overlap`, `ambiguity`, `uncertainty_pixels`, флаг `confident` и причины отказа: `shift_ambiguous`, `shift_uncertain`, `shift_low_overlap`, `invalid_max_shift`.
- `corridorDrift(corridor,{minPoints})` — боковой дрейф коридора как форма фичи плюс невязка (`residual`) и `honest_units:'image fractions; no scale, no angle'`.
- `classifyMotionSource({roadShift,minimapMotion})` разделяет то, что монокулярно неразделимо: поворот камеры на стоящей машине и поворот самой машины. Без независимого сигнала миникарты функция отвечает `unseparated_camera_or_vehicle` или `stationary_without_minimap`, а не «машина повернула». `minimap_motion` никогда не выводится внутри модуля — только принимается от вызывающего кода, иначе `no_motion_signal`.

Почему `confident` работает так, а не «через полпика»: при уникальном пике соперника нет, и раньше это давало `confident:false`. Теперь `ambiguity` при отсутствии соперника равен самому пику (нет никого, кто спорит), и решение требует одновременно `ambiguity≥minAmbiguity`, `uncertainty≤1.5 px` и `overlap≥minOverlap`. На синтетическом сдвиге 6 px: пик 1.0, соперники 5/7 px = 0.964, `overlap≈0.906` → `confident:true`. Неуверенный кадр не превращается в ноль движения, он возвращает отказ.

Проверки: `tests/javascript/ego-motion.test.mjs` — 5/5 (сдвиг + неопределённость, плоская/битая полоса, неоднозначный сдвиг, дрейф коридора, разделение камера/машина).

## 2. Аудит ложного «путь свободен» (пункт 5)

`packages/perception/false-free-audit.mjs`.

- `HAZARD_KINDS`: `curb`, `pole`, `standing_car`, `blocked_view`, `pedestrian`, `wall`, `sign`.
- `pathTube(corridor,{halfWidth,mask})` строит предполагаемый путь: узлы коридора плюс вертикальная заливка между рядами, `scope:'Constant image-space half-width…'`. Полуширина в долях кадра — это заявление о геометрии изображения, не о метрах.
- `auditFrame(p,points,{corridor,tube})` считает отдельно: `false_free` (hazard-точка попала в дорожную маску коридора), `false_free_on_path` (та же точка внутри трубки пути), `missed_road` (человек отметил дорогу, маска её не видит) и разбивку по видам `by_kind`.
- `summarizeAudit(frames,{allowAnyFalseFree})` даёт вердикт `false_free_found` / `road_not_traversable` / `no_false_free_on_labelled_points`.

`packages/perception/label-template.mjs` — разметка без выдумывания: `emptyLabelFile` не заполняет ни одной точки, `validateLabelFile` проверяет `schema_version`, дубликаты, чужие имена кадров, диапазон 0..1, известный `kind` и `SCENE_KINDS`.

CLI (оба проверены `node --check` и прогонами на синтетике):

- `experiments/tools/make-label-template.mjs <запись-или-папка> [--frames=40] [--out=] [--session=]` — берёт равномерную выборку из `samples.jsonl` или файлы `^[0-9]{6}\.jpg$`. Пишет с `flag:'wx'`, поэтому готовую разметку не перезаписывает (`Refusing to overwrite…`).
- `experiments/tools/audit-false-free.mjs <labels.json> [--root=] [--intent=] [--camera=] [--out=]` — тот же `Perception.load`, что и в живом пути, тот же `connectedRoadGeometry`; отчёт содержит `summary`, `drift_summary` (медиана/p95 дрейфа в долях кадра), `latency_ms` и `scope:'… not a driving result'`.

Проверки: `false-free-audit` 5/5, `label-template` 3/3, `false-free-tool` 4/4 (сквозной путь: файл разметки → фейковый анализатор → отчёт, включая отказ на файле без точек).

## 3. Проверки и честные ограничения

- `npm run test:core`: **172/172** (было 155), `npm audit` — 0 уязвимостей.
- Новые тестовые файлы: `ego-motion` (5), `false-free-audit` (5), `label-template` (3), `false-free-tool` (4).
- Не проверено и не может быть проверено здесь: реальные записи, сегментация/YOLOP (нет `models/`), метры и градусы, независимая validation-выборка. Разметка для пункта 5 существует только как шаблон — ни один кадр ещё не размечен человеком.
- Пороги восприятия, веса моделей, `configs/drive-safety.json` и actuator leases не менялись. Живой путь на новые измерители не переключён: это отдельный шаг после прогона на реальной записи.

## 4. Что запускать на своей машине

1. Записать сессию: `apps\gta-control\launchers\Record-Motion-Development.cmd` (120 с, `role=development`). Нужны повороты камеры на стоящей машине, прямые проезды и хотя бы одна остановка.
2. Сделать шаблон разметки: `node experiments/tools/make-label-template.mjs experiments\observation-recordings\<сессия> --frames=40`
3. Разметить вручную в `labels.json`: точки `expected:'hazard'` с `kind` и точки `expected:'road'`, плюс `scene.kind`.
4. `node experiments/tools/audit-false-free.mjs experiments\observation-recordings\<сессия>\labels.json --root=<та же папка>`
5. Прислать `false-free-report.json` (или хотя бы `summary`/`drift_summary`/`latency_ms`).

Результат такого прогона — development-аудит на синтетически размеченных кадрах, а не подтверждённое вождение.
