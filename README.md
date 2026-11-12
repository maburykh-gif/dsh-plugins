# DSH plugins: AITunnel и text.ru

Два бандла для [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) в одном
репозитории, плюс индекс маркета, чтобы их можно было ставить из интерфейса.

| Пакет | Что делает |
|---|---|
| [`packages/aitunnel-models`](packages/aitunnel-models) | шлюз AITunnel пятью разделами моделей: тексты, архитектура, дизайн, изображения, видео |
| [`packages/textru-unique`](packages/textru-unique) | проверка уникальности через API text.ru: процент, источники, фрагменты под рерайт |

## Установка из исходников

```powershell
# из папки пакета — через plugin_manager в вашем профиле
# target: абсолютный путь к packages\aitunnel-models
```

Ключи не входят в репозиторий: AITunnel читает `AITUNNEL_API_KEY`, text.ru — `TEXT_RU_KEY`
из хранилища учётных данных профиля.

## Публикация индекса маркета

Маркет в DSH не имеет центрального реестра: «магазин» — это любой https-адрес с JSON-индексом
формата 1. Поэтому публикация выглядит так:

1. Создайте пустой репозиторий на GitHub, скопируйте его адрес (https или ssh).
2. В этой папке:

```powershell
.\publish.ps1 -RepoUrl https://github.com/<user>/<repo>
```

Скрипт сделает первый коммит, соберёт `market/index.json` с реальным коммитом пакетов,
закоммитит индекс и отправит всё в `origin/main`.

3. Адрес индекса для пользователей:

```
https://raw.githubusercontent.com/<user>/<repo>/main/market/index.json
```

4. В DSH: **Настройки → Плагины → Discover → Add index** (или `plugin_market`), вставить этот
адрес. После этого плагины видны в каталоге и ставятся в один клик.

Без доступа к git-хостингу можно собрать всё локально: `.\publish.ps1 -SkipPush` создаст коммиты и
индекс, а отправить их вы сможете любым удобным способом.

## Этот репозиторий уже опубликован

- Код: <https://github.com/maburykh-gif/dsh-plugins>
- Индекс маркета: <https://raw.githubusercontent.com/maburykh-gif/dsh-plugins/main/market/index.json>

Магазин DSH не имеет центрального реестра: «магазин» — это любой https-адрес с JSON-индексом
формата 1. Поэтому достаточно добавить адрес выше как источник в Discover.

## Что проверено

- Оба бандла установлены в профиль и активируются без диагностик.
- `textru_unique` и `textru_balance` вызывались на живом API: проверка вернула процент,
  источники и фрагменты; баланс — остаток символов.
- `market/index.json` проходит `tools/validate-index.mjs` (правила формата 1).

## Лицензия

MIT — см. `LICENSE` в каждом пакете.
