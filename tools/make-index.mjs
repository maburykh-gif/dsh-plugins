#!/usr/bin/env node
// make-index.mjs — собирает market/index.json (формат 1) для четырёх плагинов.
//
//   node tools/make-index.mjs --repo https://gitlab.com/group/repo --commit <40-hex>
//
// Без --commit берёт HEAD текущего репозитория, без --repo оставляет плейсхолдер.

import { execFileSync } from 'node:child_process'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'

const args = process.argv.slice(2)
function arg(name, fallback) {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const root = join(import.meta.dirname, '..')
const repo = arg('repo', 'https://gitlab.com/YOUR-GROUP/dsh-plugins')
let commit = arg('commit', '')
if (!commit) {
  try {
    commit = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim()
  } catch {
    console.error('Не удалось прочитать HEAD: укажите --commit вручную.')
    process.exit(1)
  }
}
if (!/^[0-9a-f]{40}$/.test(commit)) {
  console.error(`Коммит должен быть 40 hex-символов, получено: ${commit}`)
  process.exit(1)
}

const now = Math.floor(Date.now() / 1000)

const index = {
  format: 1,
  title: {
    en: 'DSH plugins: AITunnel, text.ru, Russian pause and tool turbo',
    ru: 'Плагины DSH: AITunnel, text.ru, пауза и turbo',
  },
  description: {
    en: 'Four bundles for DeepSeek Harness: AITunnel model routes, text.ru uniqueness checks, a Russian-language pause gate for the composer, and adaptive reasoning effort for tool rounds.',
    ru: 'Четыре бандла для DeepSeek Harness: маршруты моделей AITunnel, проверка уникальности через text.ru, русская пауза во время ответа агента и адаптивное усилие размышления для раундов инструментов.',
  },
  metadata: {
    categories: {
      ai: { title: { en: 'AI and models', ru: 'ИИ и модели' } },
      seo: { title: { en: 'SEO and content', ru: 'SEO и контент' } },
      ui: { title: { en: 'Interface and usability', ru: 'Интерфейс и удобство' } },
      performance: { title: { en: 'Performance', ru: 'Производительность' } },
    },
    labels: {
      'needs-api-key': { title: { en: 'Needs an API key', ru: 'Нужен ключ API' } },
      russian: { title: { en: 'Russian-language', ru: 'Для русского языка' } },
    },
    sortKeys: {},
  },
  plugins: [
    {
      name: '@dsh-plugins/aitunnel-models',
      title: {
        en: 'AITunnel model routes',
        ru: 'Модели AITunnel',
      },
      description: {
        en: "Adds AITunnel's OpenAI-compatible gateway as five model sections: text, architecture, design, images and video.",
        ru: 'Подключает шлюз AITunnel пятью разделами моделей: тексты, архитектура, дизайн, изображения и видео.',
      },
      author: 'DSH Plugins contributors',
      homepage: repo,
      repository: { url: repo, directory: 'packages/aitunnel-models' },
      metadata: {
        category: 'ai',
        keywords: ['aitunnel', 'llm', 'models', 'openai-compatible', 'providers'],
        labels: ['needs-api-key'],
        sortKeys: {},
      },
      versions: [
        {
          version: '1.0.0',
          publishTimestamp: now,
          source: { type: 'git', url: repo, commit, path: 'packages/aitunnel-models' },
          engines: {},
        },
      ],
    },
    {
      name: '@dsh-plugins/textru-unique',
      title: {
        en: 'Text.ru uniqueness',
        ru: 'Проверка уникальности text.ru',
      },
      description: {
        en: 'Checks text uniqueness through the text.ru API and returns the score, matching sources and the fragments that need a rewrite.',
        ru: 'Проверяет уникальность через API text.ru и возвращает процент, источники и фрагменты, которые нужно переписать.',
      },
      author: 'DSH Plugins contributors',
      homepage: repo,
      repository: { url: repo, directory: 'packages/textru-unique' },
      metadata: {
        category: 'seo',
        keywords: ['textru', 'uniqueness', 'antiplagiat', 'seo', 'copywriting'],
        labels: ['needs-api-key', 'russian'],
        sortKeys: {},
      },
      versions: [
        {
          version: '1.0.0',
          publishTimestamp: now,
          source: { type: 'git', url: repo, commit, path: 'packages/textru-unique' },
          engines: {},
        },
      ],
    },
    {
      name: '@dsh-plugins/pause-ru',
      title: {
        en: 'Pause gate, Russian UI',
        ru: 'Пауза с русским интерфейсом',
      },
      description: {
        en: 'Pauses the agent before the next model request so you can type a steering note or just press Enter; all labels and errors are in Russian. Fork of dsh-pause (MIT).',
        ru: 'Останавливает агента перед следующим запросом к модели, чтобы можно было дописать реплику или просто нажать Enter; все надписи и ошибки по-русски. Форк dsh-pause (MIT).',
      },
      author: 'maburykh-gif (fork of better-er/dsh-pause)',
      homepage: repo,
      repository: { url: repo, directory: 'packages/pause-ru' },
      metadata: {
        category: 'ui',
        keywords: ['pause', 'steer', 'composer', 'gate', 'russian', 'localization', 'fork'],
        labels: ['russian'],
        sortKeys: {},
      },
      versions: [
        {
          version: '0.1.8-ru.1',
          publishTimestamp: now,
          source: { type: 'git', url: repo, commit, path: 'packages/pause-ru' },
          engines: {},
        },
      ],
    },
    {
      name: '@dsh-plugins/tool-turbo',
      title: {
        en: 'Adaptive reasoning effort',
        ru: 'Адаптивное усилие размышления',
      },
      description: {
        en: 'Lowers the reasoning effort of cheap tool rounds and raises it for heavy ones, so tool-driven work finishes faster. Port of dsh-tool-turbo to DSH 0.2.2 (MIT).',
        ru: 'Понижает усилие размышления на дешёвых раундах инструментов и повышает на тяжёлых, чтобы работа с инструментами шла быстрее. Порт dsh-tool-turbo на DSH 0.2.2 (MIT).',
      },
      author: 'Electricitysheep (upstream dsh-tool-turbo); порт — maburykh-gif',
      homepage: repo,
      repository: { url: repo, directory: 'packages/tool-turbo' },
      metadata: {
        category: 'performance',
        keywords: ['reasoning-effort', 'turbo', 'latency', 'port'],
        labels: [],
        sortKeys: {},
      },
      versions: [
        {
          version: '0.2.0',
          publishTimestamp: now,
          source: { type: 'git', url: repo, commit, path: 'packages/tool-turbo' },
          engines: {},
        },
      ],
    },
  ],
}

const out = join(root, 'market', 'index.json')
mkdirSync(dirname(out), { recursive: true })
writeFileSync(out, `${JSON.stringify(index, null, 2)}\n`, 'utf8')
console.log(`index: ${out}`)
console.log(`repo:  ${repo}`)
console.log(`commit:${commit}`)
