# Проверки

Из корня: `npm run test:core` без больших активов; `npm test` с локальными моделями; `npm run test:python` с `training/training-env`. JavaScript — `javascript/`, Python unittest — `python/`, общие проверенные входы — `../fixtures/`. Тестовый worker остаётся в `javascript/fixtures/`.

C# self-test встроен в `apps/gta-control/GtaControl.cs`; его запускают с `--self-test REPORT_PATH`, без обычного режима моста и игрового ввода. Команды CI находятся в `.github/workflows/ci.yml`.
