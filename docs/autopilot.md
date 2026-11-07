# GtaAutopilot: модули, эксперименты и запуск

> Исходники перенесены в монорепозиторий. Канонические пути и команды из корня: [архитектура](ARCHITECTURE.md) и [главный README](../README.md). Команды с короткими прежними именами ниже относятся к историческому запуску из `outputs/GtaAutopilot` или `outputs/GtaControl`; эти каталоги содержат переходники.

Обновлено7 ноября2026. Это экспериментальный прототип. Самостоятельная езда до назначения не подтверждена. Общая установка и текущие результаты — [главный README](../README.md), краткий статус — [CURRENT-STATUS](../CURRENT-STATUS.md), зависимости этапов — [план](../DEVELOPMENT-PLAN.md).

## Рабочие компоненты

| Файлы | Назначение |
|---|---|
| `../apps/gta-control/GtaControl.cs`, `bridge-client.mjs` | Единый захват и бинарный loopbackHTTP; токен хранится локально |
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
| `benchmark-perception-ablation.mjs`, `offline-yolop-grid.mjs` | 640+Seg / 320+Seg / 320-only; протокол, маски, повторы и частичные метки; без управления |
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

Последняя локальная проверка7 ноября:152 JS+16 Python; Windows-сборка и C# self-test выполнены на предыдущем этапе. Полный набор использует внешние модели/записи; `test:core` предназначен для включённых исходников/fixtures. Ни одна из этих команд не включает управление игрой.

## Модели и активы

Основные веса находятся локально в `packages/perception/models/`, OCR в `packages/perception/models/ocr/eng.traineddata`; конфигурации-образцы — `config/`. УстановкуC#/моделей/Python см. в [корневом README](../README.md). Зависимости/записи/ETL/веса вGit не хранятся. Активы отдельных сравнений лежат на машине разработчика, их пути в отчётах документируют происхождение, а не публичный downloadAPI.

## Последние отчёты

- [Внешний аудит и исправления](./reports/AUDIT-REMEDIATION.md): /hold gate, клавиатурный deadline от кадра, NaN времени контроллера; trial только shadow на едином наблюдении, --drive запрещён. Owner/re-arm/Python deadline ещё открыты. CI добавлен, но удалённо не запускался; dependency audit нашёл3 high-позиции.
- [Геометрия миникарты](./reports/MINIMAP-ROUTE-RESULT.md): `traceMinimapRoute` принимает заданную тонкую линию, якорь/курс/source, возвращает только геометрический кандидат. RGB-детектора нет; navigation_valid=false и intent=unknown сохраняются даже при удачной трассировке. Не подключён к контроллеру.
- [Подготовка аналоговой пробы](./reports/CALIBRATION-READINESS-RESULT.md): три согласованных свежих кадра до создания устройства и перед arm; повторы, разрывы, старые/чужие OCR и нестабильная передача дают причину отказа. Только офлайн-проверка.
- [Нулевая скорость и OCR-пунктуация](./reports/ZERO-DASH-GUARD-RESULT.md): закрыт обход проверки формы прочерка; непроверенный OCR-dash отклоняется с `unverified_zero_dash`.360 реальных ответов сохранены, новая независимая проверка малых скоростей ещё нужна.
- [Параллельная подготовка C#](./reports/PARALLEL-ENCODING-RESULT.md): независимые Bitmap для дороги/HUD/миникарты,414 точных совпадений; офлайн30→19–20мс подготовки. Полная реакция не измерена, кандидат не установлен.
- [Этапы получения кадра](./reports/ACQUISITION-PROFILE-RESULT.md): C#-таймеры и транспортные интервалы клиента;200 наблюдений, JPEG-кодек4,5мс при resize20мс и захвате26–37мс. Следующая оптимизация должна сохранять пиксели и отдельно учитывать миникарту/хвосты тела HTTP.
- [Один decode JPEG](./reports/SINGLE-DECODE-RESULT.md): `vision.analyze(bytes,{decodeOnce:true})`, default=false. Для обычного дорожного JPEG общий RGB используется двумя сетями; остальные форматы/размеры сохраняют старую обработку.214/214 точный паритет, устойчивый выигрыш скорости не подтверждён.
- [Пассивно с GTA/OCR](./reports/PASSIVE-TRANSFER-RESULT.md):160наблюдений, p95 возраста304мс с transfer против312/324мс,160/160 паритет; получение90–95мс, сам захват33–35мс. Кодирование/передача пока не разделены; один ракурс/сцена, без управления.
- [Передача выходов worker](./reports/OUTPUT-TRANSFER-RESULT.md): умеренное ускорение с точными сырыми/итоговыми выходами; опция `transferOutputs:true` третьим аргументом `createInferenceSession`/`WorkerInferenceSession.create`, default=false. Обычные загрузчики зрения её не включают; GPU-копирования и70мс Running этим не устранены.
- [Абляция YOLOP/SegFormer](./reports/PERCEPTION-ABLATION-RESULT.md): 324 обработки, 97 областей. 320 быстрее, но теряет покрытие машин; без SegFormer есть дополнительные потери дороги. Оба кандидата отклонены по качеству, рабочие модели сохранены.
- [Потоки intra1/intra3](./reports/THREAD-OPTIONS-RESULT.md):320паритетных обработок, умеренный эффектCPU/медианы, p95неустойчив; рабочие настройки сохранены.
- [Стек ожидания ORT](./reports/ETW-WAIT-STACKS-RESULT.md), [boundedETW](./reports/ETW-BOUNDED-RESULT.md), [калибровка часов](./reports/ETW-CLOCK-CHECK.md), [неполные первые записи](./reports/ETW-CAPTURE-CHECK.md). GPU/copy/queue полностью не разделены. Диагностические ETW-скрипты из локальногоwork не входят в репозиторий; описанные неудачные профили не следует запускать как готовый рецепт.
- [Профиль узлов и этапов](./reports/ORT-NODE-PROFILE-RESULT.md):heavyоператоры наDML, наCPU малые shape-векторы. Native run включает ожидания/копирование.
- [Совместная нагрузка GTA/FPS](./reports/GAME-LOAD-AB-RESULT.md), [без игры](./reports/NO-GAME-LATENCY-RESULT.md), [редкие хвосты](./reports/TAIL-TRACE-RESULT.md). Не смешивать compute-only и live-возраст кадра.
- [Aspect](./reports/SEMANTIC-ASPECT-RESULT.md), [проверка другой сессии/времени](./reports/SEMANTIC-FOLLOWUP-RESULT.md), [проверка гипотез](./reports/DIAGNOSIS-AUDIT.md).
- [Экспорт GTAONNX](./reports/GTA-ONNX-RESULT.md), [первое сравнение](./reports/PRETRAINED-COMPARISON-RESULT.md), [источники моделей](./reports/EXTERNAL-MODELS-REVIEW.md).
- [Новаяvalidation](./reports/VALIDATION-CAPTURE-RESULT.md), [пустынная дорога](./reports/DESERT-VALIDATION-RESULT.md), [частичные регионы](./reports/QUALITY-REGIONS-RESULT.md), [границы/грузовик](./reports/BOUNDARY-DETECTOR-RESULT.md).

## Данные и условия управления

Человек записывает отдельные development/validation поездки; не обучать и не выбирать пороги по отложенной сессии. Старые клавиатурные записи не содержат точных аналоговых углов и GPS-намерений. Кадр/маска/скорость имеют собственные времена, просроченные данные не становятся свежими от heartbeat или другого входа.

Ограничения аналогового контура: команда≤250 мс, возраст наблюдения≤450 мс. Фокус/F8/generation/watchdog не отключать. Нейтраль не означает физическую остановку. Связный путь не доказывает метрический зазор или правильный курс камеры. Реальные калибровки требуют подтверждённого исходного состояния и пройденных зависимостей плана.

## История предыдущих этапов

[OFFLINE-MODEL-RESULT](./reports/OFFLINE-MODEL-RESULT.md), [SEVEN-ROAD-RESULT](./reports/SEVEN-ROAD-RESULT.md), [FIRST-MOTION-RESULT](./reports/FIRST-MOTION-RESULT.md), [MOVING-PERCEPTION](./reports/MOVING-PERCEPTION.md), [LATENCY-RESULT](./reports/LATENCY-RESULT.md), [OPTIMIZATION-RESULT](./reports/OPTIMIZATION-RESULT.md).

Поведенческое клонирование и PilotNet остаются исследованием: [TRAINING-STATUS](./reports/TRAINING-STATUS.md), [TRAINING-RESULT](./reports/TRAINING-RESULT.md), [SECOND-EXPERIMENT](./reports/SECOND-EXPERIMENT.md), [CONTROL-MODEL](./reports/CONTROL-MODEL.md), [VISION-EXPERIMENT](./reports/VISION-EXPERIMENT.md), [ABLATION-RESULT](./reports/ABLATION-RESULT.md). Наличие обученных весов/экспорта не означает полезного управления; в прежних опытах базовый прогноз часто был лучше модели.

Записи и установка: [RECORDING](./reports/RECORDING.md), [GAMEPAD-INSTALLATION](./reports/GAMEPAD-INSTALLATION.md), [ROAD-RECOGNITION](./reports/ROAD-RECOGNITION.md). Исторические числа и результаты самопроверок сохраняют контекст своих этапов; актуальные выводы приведены выше.
