# Структура проекта

Переход на монорепозиторий выполнен 7 ноября 2026. Команды запускаются из корня. Это перенос исходников и путей; алгоритмы восприятия, пороги, веса, leases и профиль DirectML сохранены. Новых результатов езды или ускорения этот перенос не даёт.

```text
GTA---AI/
├── apps/gta-control/        # C#-мост, сборка, Windows launchers и CLI
├── packages/
│   ├── perception/         # ONNX workers, OCR, маски, геометрия дороги
│   ├── navigation/         # намерение, миникарта, кандидат пути
│   ├── control/            # контроллер и политики допуска/калибровки
│   ├── actuation/          # клавиатурный клиент и Python gamepad backend
│   └── protocols/          # HTTP-клиент, метаданные, запись, таймеры
├── training/               # обучение, датасеты, сохранённые модели управления
├── experiments/tools/      # сравнения, экспорт ONNX, профилирование, replay
├── tests/javascript/       # Node test runner
├── tests/python/           # unittest, mock backend
├── fixtures/               # небольшие проверенные входы в Git
├── configs/                # конфигурации, шаблоны HUD, звуки записи
├── docs/reports/            # сохранённые отчёты экспериментов
├── models-manifest.json    # пути, размеры и SHA-256 активов
├── package.json            # общие зависимости, workspaces и команды
└── .github/workflows/      # офлайн-проверки и аудит зависимостей
```

## Ответственность компонентов

| Каталог | Содержимое и граница |
|---|---|
| `apps/gta-control` | `GtaControl.cs`, `Build.ps1`, `Start.cmd`; CLI связывает библиотеки. Запуск приложения по-прежнему отдельное действие. |
| `packages/perception` | YOLOP, SegFormer, Tesseract, нормализация, road-corridor. Не отправляет команды машине. |
| `packages/navigation` | Контекст назначения и геометрия; миникарта пока принимает заданную линию, реального RGB GPS-контура нет. |
| `packages/control` | Выбор команды, проверки состояния, офлайн-адаптеры моделей. Не создаёт устройство ввода. |
| `packages/actuation` | Исполнение и ограничение срока команды. Python остаётся постоянным процессом. Общий владелец keyboard/gamepad и явный re-arm реализованы, [проверки](reports/INPUT-OWNERSHIP-RESULT.md); фиксированный deadline решений до реальных Python-команд также реализован, [проверки](reports/DECISION-DEADLINE-RESULT.md). |
| `packages/protocols` | Клиент существующего loopback API, времена/sequence/generation, служебные протоколы записи. Wire-format API сохранён. |
| `training` | Обучение/подготовка данных. Не повышает кандидата до рабочего контура автоматически. |
| `experiments` | Воспроизводимые офлайн-инструменты, записи и результаты запусков; отчёты для Git в `docs/reports`. |

Пакеты оформлены как приватные npm workspaces `@gta/*`. Для разработки используются явные относительные импорты; зависимости JavaScript и lock-файл общие в корне. Существующие языки и транспорт не заменены: C# захват → бинарный HTTP → Node.js; аналоговый backend — Python.

ObservationStream/ObservationAnalyzer связывают живые режимы с одним пакетом road/HUD/map и временем источника. DriveSafetyGate в `packages/control` проверяет калибровочные доказательства и текущее состояние, выдаёт ограниченное разрешение; реальные исполнители требуют его перед подготовкой и командой. Владелец и source deadline в C#/Python остаются независимыми ограничителями. Старые `/action` и `/step` отклоняются. [Контракт, проверки и отсутствующие реальные калибровки](reports/SAFETY-CHECKLIST-RESULT.md).

## Данные и конфигурация

| Канонический путь | Локальный каталог данных на этой машине |
|---|---|
| `packages/perception/models` | `D:/GTA-AI-data/models` |
| `training/trained` | `D:/GTA-AI-data/trained` |
| `training/training-env` | `D:/GTA-AI-data/training-env` |
| `training/datasets` | `D:/GTA-AI-data/datasets` |
| `experiments/recordings` | `D:/GTA-AI-data/recordings` |
| `experiments/observation-recordings` | `D:/GTA-AI-data/observation-recordings` |
| `experiments/runs` | `D:/GTA-AI-data/runs` |

Это локальные junction, их содержимое не переносилось и не включается в Git. В чистом клоне создайте обычные каталоги по каноническим путям и разместите свои активы; наличие диска D не требуется. `npm ci` устанавливает зависимости. С8 ноября корневой `node_modules` — обычный локальный npm-каталог; прежняя установка на D сохранена вместе с резервной копией. При обновлении npm сам заменил прежнюю ссылку, содержимое данных на D не удалялось.

Активные `gear-templates.json` и `segformer-config.json` перенесены в `configs` без изменения байтов; код читает именно их. `models-manifest.json` фиксирует фактически установленные файлы, а не скачивает их. Неизвестное точное происхождение экспортов/лицензий явно отмечено; название исходного проекта не заменяет проверку лицензии конкретных весов. Команда `npm run models:verify` сверяет размер и SHA-256; необязательный отсутствующий актив выводится отдельно.

Новый default для подключения — приватный `apps/gta-control/connection.json`, который записывает C#-мост рядом с EXE. Клиенты принимают явный путь к конфигурации, если используется другая установка. Токены в Git не попадают.

## Совместимость

В `outputs/GtaAutopilot` и `outputs/GtaControl` оставлены переходники для старых импортов, команд и ссылок. Реализация теперь одна, в канонических каталогах. Старые junction активов сохранены: исторические конфигурации обучения могут содержать абсолютные или относительные прежние пути. Новые эксперименты запускайте из корня и используйте новые пути. `npm test` из старого каталога перенаправляется в корень.

Переходники JavaScript сохраняют `process.argv[1]` для CLI с проверкой main-module. Python-переходники выполняют канонический файл через `runpy`; исходники Python импортируют модули из корня проекта. Старые `.cmd` вызывают новые launchers. Исторические отчёты и их числа сохранены; старые команды в тексте отчётов могут требовать прежней рабочей папки. Снимок исходников и таблица переноса находятся локально в `work/restructure/`.

## Проверки

```powershell
npm ci
npm run test:core
npm test
npm run test:python
npm run models:verify
powershell.exe -NoProfile -ExecutionPolicy Bypass -File apps/gta-control/Build.ps1 -OutputPath work/restructure/GtaControl-check.exe
```

Полный JS-набор требует локальных моделей, Python — подготовленного окружения `training/training-env`. Сборку C# дополнительно проверяют запуском полученного EXE с `--self-test REPORT_PATH`: этот режим не захватывает игру и не выполняет игровой ввод. Каталог для `OutputPath` создаётся заранее. CI проверяет core без моделей на Linux/Windows, C# self-test и stdlib Python на Windows. Удалённый CI опубликованного программного чек-листа прошёл; статус новых коммитов виден в [Actions](https://github.com/doger537/GTA---AI/actions/workflows/ci.yml). Три прежние npm-позиции исправлены8 ноября с проверкой точного совпадения выходов; [отчёт обновления](reports/DEPENDENCY-REMEDIATION-RESULT.md).

Локально после закрытия программного чек-листа:180/180 JavaScript,43/43 Python,18 групп C# self-test;118 core и27 stdlib Python. Игру, обычный режим моста, запись и управление при этих изменениях не запускали. Ограничения автопилота перечислены в [текущем состоянии](../CURRENT-STATUS.md).
