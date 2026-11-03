# GTA — AI

Экспериментальный автопилот GTA V по изображению экрана: локальный C#-мост для Windows, распознавание на Node.js, обучение и виртуальный геймпад на Python.

**Надёжная самостоятельная езда до GPS-метки пока не получена.** В последней диагностической поездке скорость подтверждена на 24/40 проверенных кадрах, передача — 40/40, дорожный путь — 3/40. [Текущее состояние](CURRENT-STATUS.md).

## Подготовка

Нужны Windows, Node.js 20+ с npm и Windows PowerShell для C#-сборки. Для Python-компонентов использовался Python 3.12.

```powershell
cd outputs/GtaAutopilot
npm ci
npm run test:core
```

Базовые тесты не запускают игру и не требуют записей/весов. Полный `npm test` дополнительно требует локальных моделей, записей и Python-окружения; они не включены в репозиторий.

Из корня репозитория собрать мост:

```powershell
powershell.exe -NoProfile -File outputs/GtaControl/Build.ps1
```

Запуск: `outputs/GtaControl/Start.cmd`. Приложение создаёт локальный `connection.json` с токеном; файл исключён из Git.

## Дополнительные активы

Для OCR нужен `outputs/GtaAutopilot/models/ocr/eng.traineddata`; для дорожного зрения — `models/yolop-640.onnx` (или 320) и `models/segformer-cityscapes.onnx`. Скопировать небольшие `config/segformer-config.json` и `config/gear-templates.json` в локальный `models/`, сохраняя соответствие конфигурации модели. Большие веса и исходные записи в репозитории отсутствуют; автоматического восстановления всех активов пока нет.

Для Python создать `outputs/GtaAutopilot/training-env` и установить необходимые `requirements-*.txt`. Реальный виртуальный геймпад также требует драйвера; см. [инструкции](outputs/GtaAutopilot/GAMEPAD-INSTALLATION.md). Он не нужен для чтения записей экрана.

Ручная запись: `Record-Motion-Development.cmd`. Независимая поездка после фиксации параметров: `Record-Motion-Validation.cmd`. В этих режимах водит человек, программа только записывает. F8 завершает попытку, потеря фокуса при пассивной записи приостанавливает захват. У управляющего исполнителя потеря фокуса останавливает ввод.

## Документация

[Подробный план дальнейшей разработки](DEVELOPMENT-PLAN.md): восприятие в движении, калибровка, препятствия, GPS, сбор данных и условия перехода между этапами.

Программа: [GtaAutopilot](outputs/GtaAutopilot/README.md), мост к игре: [GtaControl](outputs/GtaControl/README.md).

Последний этап, 3 ноября 2026: [первая новая поездка и оценка восприятия в движении](outputs/GtaAutopilot/FIRST-MOTION-RESULT.md). Предыдущие этапы: [единый захват и исправление одиночной 7](outputs/GtaAutopilot/MOVING-PERCEPTION.md), [рабочие потоки ONNX](outputs/GtaAutopilot/LATENCY-RESULT.md), [оптимизация](outputs/GtaAutopilot/OPTIMIZATION-RESULT.md).

Веса, записи, результаты запусков, зависимости, exe и приватная память исключены через `.gitignore`. Ссылки исторических отчётов на локальные данные не означают, что они доступны в чистом клоне.
