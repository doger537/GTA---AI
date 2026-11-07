# Обучение

CLI и Python-архитектуры обучения перенесены сюда из `outputs/GtaAutopilot`. Запускайте команды из корня, например `node training/prepare-dataset.mjs experiments/recordings/SESSION`.

Большие данные находятся в игнорируемых `training/datasets`, веса управления — `training/trained`, Python — `training/training-env`. Исходные записи сохранены в `experiments/recordings` и `experiments/observation-recordings`. Разделение по сессиям и защищённая validation-поездка остаются обязательными; свободная езда не содержит GPS-намерений. Подробнее: [план](../DEVELOPMENT-PLAN.md).
