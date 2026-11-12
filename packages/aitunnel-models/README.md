# AITunnel model routes

Bundle for DeepSeek Harness that adds **AITunnel** (`https://api.aitunnel.ru/v1`, OpenAI-compatible)
to the model picker as five sections instead of one long list:

| Section | Purpose |
|---|---|
| API для текстов | articles, copywriting, SEO, analysis |
| API для архитектора | architecture, hard refactors, bug hunts |
| API для дизайна | layout, UI/UX, design systems, HTML/CSS |
| API для изображений | image generation (catalog; generation runs outside chat) |
| API для видео | video generation (catalog; generation runs outside chat) |

## Install

1. Get an API key at [api.aitunnel.ru](https://api.aitunnel.ru).
2. Install the bundle and open **Settings → Models**.
3. Paste the key into the AITunnel provider card. It is stored in the profile's credential
   store as `AITUNNEL_API_KEY`, never in this package or in the configuration file.
4. Restart the application — the sections appear in the picker.

Image and video sections are catalogs only: the chat engine serves text dialogs, so selecting
one of those models in chat produces no answer. Generate images and video with your own script
or a companion tool.

## Configuration

The bundle declares `llm-pi-ai` with `providers`. A bundle layer applies **before** the
profile's own `cordis.patch.yml`, so a user who already lists providers there keeps theirs —
this bundle never overwrites a user configuration.

To keep only some sections, override the row in your profile patch with the complete `config`
you want; a matching override replaces the whole `config` object.

## Requirements

- DeepSeek Harness with the `llm-pi-ai` plugin available (shipped by default).
- Network access to `api.aitunnel.ru`.

## Notes

- Model ids, context windows and token limits mirror the gateway catalog at the time of
  publishing (November 2026). The gateway lists ~400 models; extend the lists in the profile
  patch if you need more.
- Pricing is the gateway's; nothing here is free.

## License

MIT.
