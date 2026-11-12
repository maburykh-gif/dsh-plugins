/**
 * Text.ru uniqueness checks for DeepSeek Harness.
 *
 * Registers two tools:
 *   textru_unique  — submit text, wait for the check, return score, sources and flagged fragments
 *   textru_balance — remaining characters on the account
 *
 * The API key is read per call from the credential store (default name TEXT_RU_KEY) and never
 * stored in configuration. Protocol: POST https://api.text.ru/post, then poll the same endpoint
 * with the uid until `text_unique` arrives.
 */

const API = 'https://api.text.ru'

const FATAL = {
  110: 'text is missing',
  111: 'text is empty',
  112: 'text is too short (100 characters minimum)',
  113: 'text is too long — split it into parts',
  120: 'API key is missing',
  121: 'API key is empty',
  141: 'unknown API key',
  142: 'not enough characters on the balance',
  146: 'access is restricted',
  150: 'text is too short to find shingles',
  180: 'key/uid pair is unknown',
  182: 'the check failed, characters are refunded',
  429: 'rate limit reached (10 texts/second, 3M characters/hour)',
}

function fail(code, desc) {
  return new Error(`text.ru ${code}: ${FATAL[code] ?? desc ?? 'unknown error'}`)
}

async function post(body) {
  const res = await fetch(`${API}/post`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  const data = await res.json().catch(() => ({}))
  return data
}

function asObject(value) {
  if (!value) return null
  if (typeof value === 'object') return value
  try {
    const parsed = JSON.parse(value)
    return typeof parsed === 'object' && parsed !== null ? parsed : null
  } catch {
    return null
  }
}

function tokenize(text) {
  const out = []
  const re = /[A-Za-zА-Яа-яЁё0-9]+(?:[-'][A-Za-zА-Яа-яЁё0-9]+)*/g
  let m
  while ((m = re.exec(text))) out.push({ start: m.index, end: m.index + m[0].length })
  return out
}

/** Turn text.ru word indexes into sentence-sized fragments of the original text. */
function fragmentsOf(text, resultJson) {
  const urls = resultJson?.urls ?? []
  if (!urls.length) return []
  const tokens = tokenize(text)
  const clearCount = String(resultJson.clear_text ?? '').split(/\s+/).filter(Boolean).length
  if (!tokens.length) return []
  if (clearCount && Math.abs(tokens.length - clearCount) > Math.max(3, tokens.length * 0.05)) return []

  const byToken = new Map()
  for (const entry of urls) {
    const indexes = String(entry.words ?? '').split(/\s+/).filter(Boolean).map(Number)
    for (const index of indexes) {
      const token = tokens[index]
      if (!token) continue
      const existing = byToken.get(token.start)
      if (existing) existing.sources.push({ url: entry.url, plagiat: entry.plagiat })
      else byToken.set(token.start, { start: token.start, sources: [{ url: entry.url, plagiat: entry.plagiat }] })
    }
  }

  const sentenceStart = (pos) => {
    for (let i = pos - 1; i >= 0; i -= 1) if (/[.!?\n]/.test(text[i])) return i + 1
    return 0
  }
  const sentenceEnd = (pos) => {
    for (let i = pos; i < text.length; i += 1) if (/[.!?\n]/.test(text[i])) return i + 1
    return text.length
  }

  const ranges = []
  for (const start of [...byToken.keys()].sort((a, b) => a - b)) {
    const from = sentenceStart(start)
    const to = sentenceEnd(start)
    const last = ranges[ranges.length - 1]
    if (last && from <= last.to) {
      last.to = Math.max(last.to, to)
      for (const source of byToken.get(start).sources) {
        if (!last.sources.some((s) => s.url === source.url)) last.sources.push(source)
      }
    } else {
      ranges.push({ from, to, sources: [...byToken.get(start).sources] })
    }
  }

  return ranges
    .map((range) => ({ text: text.slice(range.from, range.to).trim(), sources: range.sources }))
    .filter((fragment) => fragment.text.length > 30)
}

export const name = 'textru-unique'

export const inject = ['tools']

export function apply(ctx, config = {}) {
  const apiKeyEnv = typeof config.apiKeyEnv === 'string' && config.apiKeyEnv ? config.apiKeyEnv : 'TEXT_RU_KEY'
  const pollIntervalMs = Number(config.pollIntervalMs) > 0 ? Number(config.pollIntervalMs) : 4000
  const timeoutMs = Number(config.timeoutMs) > 0 ? Number(config.timeoutMs) : 300000

  async function apiKey() {
    const credentials = ctx.get('credentials')
    if (credentials) {
      const resolved = await credentials.resolve(apiKeyEnv)
      if (resolved?.value) return resolved.value
    }
    const fromEnv = process.env[apiKeyEnv]
    if (fromEnv) return fromEnv
    throw new Error(
      `text.ru API key is not configured: store it as ${apiKeyEnv} in the DSH credential store`,
    )
  }

  async function submit(text, options) {
    const body = { userkey: await apiKey(), text }
    if (options?.exceptdomain) body.exceptdomain = options.exceptdomain
    if (options?.excepturl) body.excepturl = options.excepturl
    const result = await post(body)
    if (result.error_code) throw fail(result.error_code, result.error_desc)
    if (!result.text_uid) throw new Error('text.ru returned no uid')
    return result.text_uid
  }

  async function poll(uid, signal) {
    const started = Date.now()
    let delay = 2000
    for (;;) {
      if (signal?.aborted) throw new Error('aborted')
      const result = await post({ userkey: await apiKey(), uid, jsonvisible: 'detail' })
      if (!result.error_code) return result
      if (result.error_code !== 181) throw fail(result.error_code, result.error_desc)
      if (Date.now() - started > timeoutMs) {
        throw new Error(`text.ru did not finish in ${Math.round(timeoutMs / 1000)}s (uid ${uid})`)
      }
      await new Promise((resolve) => setTimeout(resolve, delay))
      delay = Math.min(delay + 1000, 10000)
    }
  }

  async function check(text, options, signal) {
    if (typeof text !== 'string' || text.trim().length < 100) {
      throw new Error('text.ru accepts texts of 100 characters and more')
    }
    const uid = await submit(text, options)
    const result = await poll(uid, signal)
    const resultJson = asObject(result.result_json) ?? {}
    const seo = asObject(result.seo_check)
    return {
      unique: Number(result.text_unique ?? resultJson.unique ?? 0),
      uid,
      link: `https://text.ru/antiplagiat/${uid}`,
      checkedAt: resultJson.date_check ?? '',
      sources: (resultJson.urls ?? []).map((entry) => ({ url: entry.url, plagiat: entry.plagiat })),
      fragments: fragmentsOf(text, resultJson),
      waterPercent: seo?.water_percent ?? null,
      spamPercent: seo?.spam_percent ?? null,
      words: seo?.count_words ?? null,
    }
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: 'textru_unique',
      description:
        'Check text uniqueness through the text.ru API. Submits the text, waits for the result and returns the score, the matching sources and the fragments that make the text non-unique. Use it when a brief requires a uniqueness threshold; rewrite flagged fragments and check again.',
      parameters: {
        type: 'object',
        properties: {
          text: {
            type: 'string',
            description: 'Text to check, at least 100 characters.',
          },
          exceptdomain: {
            type: 'string',
            description: 'Comma- or space-separated domains to exclude from the check, e.g. the client site.',
          },
          excepturl: {
            type: 'string',
            description: 'Comma- or space-separated URLs to exclude from the check.',
          },
        },
        required: ['text'],
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            unique: { type: 'number' },
            uid: { type: 'string' },
            link: { type: 'string' },
            checkedAt: { type: 'string' },
            sources: { type: 'array', items: { type: 'object' } },
            fragments: { type: 'array', items: { type: 'object' } },
          },
          additionalProperties: true,
        },
        render: (args, value) => {
          const summary = [
            `Uniqueness: ${value.unique}%`,
            `Report: ${value.link}`,
            value.sources.length ? `Sources: ${value.sources.length}` : 'No matches found',
            value.fragments.length ? `Fragments to rewrite: ${value.fragments.length}` : '',
          ].filter(Boolean)
          return [{ type: 'text', text: summary.join('\n') }]
        },
      },
      execute: async (args, exec) => check(args.text, args, exec?.signal),
    }),
  )

  ctx.effect(() =>
    ctx.tools.register({
      name: 'textru_balance',
      description: 'Remaining text.ru characters on the account that owns the configured API key.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
      output: {
        schema: { type: 'object', properties: { size: { type: 'number' } }, additionalProperties: false },
        render: (args, value) => [{ type: 'text', text: `text.ru balance: ${value.size} characters` }],
      },
      execute: async () => {
        const res = await fetch(`${API}/account`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ userkey: await apiKey(), method: 'get_packages_info' }),
        })
        const data = await res.json().catch(() => ({}))
        if (data.error_code) throw fail(data.error_code, data.error_desc)
        return { size: Number(data.size ?? 0) }
      },
    }),
  )
}
