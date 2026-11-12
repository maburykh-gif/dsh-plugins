# tool-turbo — усилие размышления под задачу

Порт [`dsh-tool-turbo`](https://github.com/Electricitysheep/dsh-tool-turbo) на DeepSeek Harness 0.2.2-rc.1.
Плагин подбирает `reasoningEffort` под текущий раунд инструментов: дешёвые
детерминированные шаги идут на низком усилии, тяжёлые — на высоком.

## Зачем

Основная часть времени шага с инструментами — размышление модели, а не сама
команда. Для `read`/`grep`/`bash`-раунда незачем думать на максимуме: тот же
результат получается в разы быстрее на низком усилии. Плагин смотрит на только
что завершённый assistant-ответ: какие инструменты вызваны и насколько тяжёлые
аргументы, — и выбирает усилие для следующего запроса.

## Что важно знать про устройство DSH 0.2.2

Оригинал подменял `reasoningEffort` в waterfall'е `agent/request`. В 0.2.2 так
нельзя: loop фиксирует выбор модели **до** `agent/request`, а подмена полей в
этом waterfall'е бросает ошибку `use agent.model.select() before step
preparation`. Штатный путь — `agent.model.select({provider, model,
reasoningEffort})`, он пишет durable-событие `model/selection`.

`preStep()` читает текущий выбор раньше, чем запускает `agent/pre-step`,
поэтому выбор внутри pre-step влияет только на следующий шаг. Плагин учитывает
это: решение принимается в момент, когда зафиксирован assistant-ответ с
`tool-call` блоками, — ровно перед следующим pre-step.

## Поведение

* assistant-сообщение с tool-call блоками → считаем долю дешёвых вызовов и
  максимальный размер аргументов:
  * ≥ 75 % дешёвых → **понижаем** усилие (ближайший к `low`);
  * самые тяжёлые аргументы ≥ 3200 символов → **повышаем** (ближайший к `max`);
  * иначе — не трогаем.
* assistant-сообщение без tool-call (финальный ответ) или `turn/end` → плагин
  **возвращает** исходный выбор пользователя.
* Меняется только `reasoningEffort`; провайдер и модель остаются прежними.
* Смена только усилия не порождает в чате уведомление о смене модели.
* Уровни берутся из каталога провайдера (`llm.resolveModelInfo`): нативный
  DeepSeek — `off/low/high/max`, pi-ai-маршруты — `off/minimal/low/medium/high/xhigh/max`.
  Ничего не хардкодится, незнакомые провайдеру id не выбираются.

## Установка

Ставится менеджером плагинов DSH (Settings → Плагины) или инструментом
`plugin_manager`; достаточно обновить страницу.

```powershell
plugin_manager install_bundle "D:\\Deepseek\\market-plugins\\packages\\tool-turbo"
```

Из индекса рынка: `https://raw.githubusercontent.com/maburykh-gif/dsh-plugins/main/market/index.json`.

## Настройка

```yaml
plugins:
  tool-turbo:
    enabled: true          # выключатель плагина
    allowDowngrade: true   # разрешить понижать усилие ниже выбранного
    allowUpgrade: false    # разрешить повышать выше выбранного (по умолчанию выкл.)
    baseline: high         # запасной базовый уровень, если провайдер не сообщает свой
    window: 8              # сколько последних tool-вызовов учитывать
```

Каждое изменение пишется в лог одной строкой:
`[tool-turbo] cheap: high -> low (calls=2, provider=deepseek-account/deepseek-flash)`.

## Проверка

```powershell
node --test        # юнит-тесты чистой политики
node --check lib/index.js
```

## Отличия от апстрима

| | dsh-tool-turbo | tool-turbo |
|---|---|---|
| Точка инъекции | `agent/request` waterfall | `agent.model.select()` + assistant/message |
| Уровни effort | хардкод low/high/max | каталог провайдера в рантайме |
| Возврат к базовому уровню | нет | да (конец раунда инструментов) |
| Телеметрия инструментов | `agent/tool` (в 0.2.2 нет) | убрана |
| Сборка | `src/*.ts` без сборки | чистый ESM `lib/*.js` + `node --test` |
| peer-требования | `dsh-agent ^0.1.0-rc.6` → отказ на 0.2.2 | `dsh ^0.2.2-rc.1` |

## Лицензия и атрибуция

MIT. `Copyright (c) 2026 Electricitysheep` — оригинал; порт на 0.2.2 —
maburykh-gif. Полный текст в [LICENSE](./LICENSE), детали изменений в
[NOTICE](./NOTICE). Пакет публикуется под своим именем, как требует MIT.
