# GtaAutopilot: модули, эксперименты и запуск

Обновлено4 ноября2026. Это экспериментальный прототип. Самостоятельная езда до назначения не подтверждена. Общая установка и текущие результаты — [главный README](../../README.md), краткий статус — [CURRENT-STATUS](../../CURRENT-STATUS.md), зависимости этапов — [план](../../DEVELOPMENT-PLAN.md).

## Рабочие компоненты

| Файлы | Назначение |
|---|---|
| `../GtaControl/GtaControl.cs`, `bridge-client.mjs` | Единый захват и бинарный loopbackHTTP; токен хранится локально |
| `perception.mjs` | YOLOP640: боксы и линии; объединение с семантикой |
| `semantic-road.mjs`, `vision-tensor.mjs` | SegFormer512: float32ImageNet, классы/вероятности, сетка128×128 |
| `inference-session.mjs`, `inference-worker.mjs` | Native ORT во workers; общий последовательный допуск DirectML, отсутствие очереди кадров |
| `camera-profile.mjs`, `road-occlusion.mjs` | Исключения HUD/кузова и закрытые машинами области; скрытая дорога не дорисовывается |
| `road-corridor.mjs`, `road-guidance.mjs` | Связный путь в изображении и gate; не метрические габариты или полоса |
| `vehicle-state.mjs`, `speed-reader.mjs`, `hud-profile.mjs` | OCR скорости/передачи и временные проверки, unknown при отказе |
| `analog-actuator.mjs`, `gamepad_backend.py` | Постоянный backend, ограниченная команда, проверка фокуса/F8/lease |
| `navigation-context.mjs` | Явное намерение с временем; автоматического чтения полногоGPS ещё нет |

DirectML указан явно. Две native-сессии исполняются последовательно, OCR/подготовка могут перекрываться. `intraOpNumThreads` рабочего режима3. Опции aspect/intra1 проверялись отдельно, не включены по умолчанию. Python не запускается заново на каждой команде. Уменьшение числа языков или применение TensorRT само по себе не является измеренным ускорением.

## Офлайн-инструменты

Запускать из корня репозитория, еслиCLI не указывает иное. Обязательные аргументы уточнять в начале соответствующего файла: часть исследовательскихCLI привязана к локальному набору данных.

| Инструменты | Что проверяют |
|---|---|
| `export-gta-onnx.py`, `review-gta-onnx.py` | GTA checkpoint→ONNX, отдельный inference-кандидат |
| `compare-pretrained-*.mjs/.py`, `summarize-pretrained-comparison.mjs` | Предобученные кандидаты и замороженные кадры |
| `evaluate-quality-regions.mjs`, `evaluate-road-boundaries.mjs` | Частичные метки дороги/границ/препятствий |
| `diagnose-gta-detections.py` | Сырые детекции доNMS |
| `compare-semantic-aspect.mjs`, `profile-semantic-candidate.mjs` | Aspect-кандидат, качество и вычислительное время |
| `trace-compute-tail.mjs`, `inference-trace.mjs`, `latency-trace.mjs` | Вложенные таймеры, очередь/RPC/native, GC/event-loop |
| `profile-capture.mjs`, `profile-pipeline.mjs` | Отдельно включаемый пассивный живой замер, без исполнительных команд |
| `train-hud-digits.mjs`, `hud-digit-model.mjs` | Экспериментальные эталоны цифр; обычный профиль оставлен прежним |

Разовый этап подготовки окружения:

```powershell
cd outputs/GtaAutopilot
npm ci
npm run test:core
```

Полная проверка локального проекта:

```powershell
npm test
training-env/Scripts/python.exe -m unittest test_ablation.py test_integration.py
```

Публикуемые исходники проверены130 JS+16 Python. Полный набор использует внешние модели/записи; `test:core` предназначен для включённых исходников/fixtures. Ни одна из этих команд не включает управление игрой.

## Модели и активы

Основные веса находятся локально в `models/`, OCR в `models/ocr/eng.traineddata`; конфигурации-образцы — `config/`. УстановкуC#/моделей/Python см. в [корневом README](../../README.md). Зависимости/записи/ETL/веса вGit не хранятся. Активы отдельных сравнений лежат на машине разработчика, их пути в отчётах документируют происхождение, а не публичный downloadAPI.

## Последние отчёты

- [Потоки intra1/intra3](THREAD-OPTIONS-RESULT.md):320паритетных обработок, умеренный эффектCPU/медианы, p95неустойчив; рабочие настройки сохранены.
- [Стек ожидания ORT](ETW-WAIT-STACKS-RESULT.md), [boundedETW](ETW-BOUNDED-RESULT.md), [калибровка часов](ETW-CLOCK-CHECK.md), [неполные первые записи](ETW-CAPTURE-CHECK.md). GPU/copy/queue полностью не разделены. Диагностические ETW-скрипты из локальногоwork не входят в репозиторий; описанные неудачные профили не следует запускать как готовый рецепт.
- [Профиль узлов и этапов](ORT-NODE-PROFILE-RESULT.md):heavyоператоры наDML, наCPU малые shape-векторы. Native run включает ожидания/копирование.
- [Совместная нагрузка GTA/FPS](GAME-LOAD-AB-RESULT.md), [без игры](NO-GAME-LATENCY-RESULT.md), [редкие хвосты](TAIL-TRACE-RESULT.md). Не смешивать compute-only и live-возраст кадра.
- [Aspect](SEMANTIC-ASPECT-RESULT.md), [проверка другой сессии/времени](SEMANTIC-FOLLOWUP-RESULT.md), [проверка гипотез](DIAGNOSIS-AUDIT.md).
- [Экспорт GTAONNX](GTA-ONNX-RESULT.md), [первое сравнение](PRETRAINED-COMPARISON-RESULT.md), [источники моделей](EXTERNAL-MODELS-REVIEW.md).
- [Новаяvalidation](VALIDATION-CAPTURE-RESULT.md), [пустынная дорога](DESERT-VALIDATION-RESULT.md), [частичные регионы](QUALITY-REGIONS-RESULT.md), [границы/грузовик](BOUNDARY-DETECTOR-RESULT.md).

## Данные и условия управления

Человек записывает отдельные development/validation поездки; не обучать и не выбирать пороги по отложенной сессии. Старые клавиатурные записи не содержат точных аналоговых углов и GPS-намерений. Кадр/маска/скорость имеют собственные времена, просроченные данные не становятся свежими от heartbeat или другого входа.

Ограничения аналогового контура: команда≤250 мс, возраст наблюдения≤450 мс. Фокус/F8/generation/watchdog не отключать. Нейтраль не означает физическую остановку. Связный путь не доказывает метрический зазор или правильный курс камеры. Реальные калибровки требуют подтверждённого исходного состояния и пройденных зависимостей плана.

## История предыдущих этапов

[OFFLINE-MODEL-RESULT](OFFLINE-MODEL-RESULT.md), [SEVEN-ROAD-RESULT](SEVEN-ROAD-RESULT.md), [FIRST-MOTION-RESULT](FIRST-MOTION-RESULT.md), [MOVING-PERCEPTION](MOVING-PERCEPTION.md), [LATENCY-RESULT](LATENCY-RESULT.md), [OPTIMIZATION-RESULT](OPTIMIZATION-RESULT.md).

Поведенческое клонирование и PilotNet остаются исследованием: [TRAINING-STATUS](TRAINING-STATUS.md), [TRAINING-RESULT](TRAINING-RESULT.md), [SECOND-EXPERIMENT](SECOND-EXPERIMENT.md), [CONTROL-MODEL](CONTROL-MODEL.md), [VISION-EXPERIMENT](VISION-EXPERIMENT.md), [ABLATION-RESULT](ABLATION-RESULT.md). Наличие обученных весов/экспорта не означает полезного управления; в прежних опытах базовый прогноз часто был лучше модели.

Записи и установка: [RECORDING](RECORDING.md), [GAMEPAD-INSTALLATION](GAMEPAD-INSTALLATION.md), [ROAD-RECOGNITION](ROAD-RECOGNITION.md). Исторические числа и результаты самопроверок сохраняют контекст своих этапов; актуальные выводы приведены выше.
