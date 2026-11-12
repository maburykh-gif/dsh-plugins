/**
 * tool-turbo: подбор усилия размышления под текущий раунд инструментов.
 *
 * Порт dsh-tool-turbo на DSH 0.2.2-rc.1. Оригинал перехватывал waterfall
 * `agent/request` и подменял reasoningEffort в предложенной конфигурации. В
 * 0.2.2 так нельзя: loop фиксирует выбор модели ДО `agent/request`, а подмена
 * полей в этом waterfall'е бросает ошибку
 * «use agent.model.select() before step preparation».
 *
 * Штатный путь — `agent.model.select({provider, model, reasoningEffort})`:
 * он пишет durable-событие `model/selection`, и loop захватывает новое
 * значение на следующем шаге (`preStep()` читает `agent.model.current()`
 * раньше, чем запускает `agent/pre-step`, — поэтому выбор, сделанный внутри
 * pre-step, влияет только на шаг после него).
 *
 * Отсюда схема: как только шаг закончился assistant-сообщением с tool-call
 * блоками, считаем политику по этим вызовам и выбираем усилие ДО следующего
 * шага; как только приходит assistant-сообщение без tool-call (финальный
 * ответ) или завершается turn, возвращаем исходный выбор пользователя.
 * Смена только reasoningEffort не порождает уведомление о смене модели.
 *
 * @module @dsh-plugins/tool-turbo
 */
import z from '@deepseek-ai/schemastery'
import { decideTarget, pickEffort, strengthOf, toolCallsOf, trimWindow } from './effort-policy.js'

/** Имя плагина; совпадает с id в cordis.patch.yml. */
export const name = 'tool-turbo'

/** Хостовые сервисы: llm нужен для каталога уровней размышления провайдера. */
export const inject = ['llm']

/** Пользовательские настройки. */
export const Config = z.object({
	enabled: z.boolean().default(true),
	allowDowngrade: z.boolean().default(true),
	allowUpgrade: z.boolean().default(false),
	baseline: z.string().default('high'),
	window: z.number().default(8)
})

const DEFAULT_CONFIG = Object.freeze({
	enabled: true,
	allowDowngrade: true,
	allowUpgrade: false,
	baseline: 'high',
	window: 8
})

/**
 * Смонтировать плагин.
 * @param {import('@deepseek-ai/cordis').Context} ctx - контекст плагина.
 * @param {Partial<typeof DEFAULT_CONFIG>} [config] - разрешённая конфигурация.
 */
export function apply(ctx, config) {
	const cfg = { ...DEFAULT_CONFIG, ...normalize(config) }
	if (!cfg.enabled) return

	const agents = new Map()
	const originals = new Map()
	const samples = new Map()
	const chains = new Map()
	const catalog = new Map()

	const log = (message) => {
		if (typeof ctx.logger?.info === 'function') ctx.logger.info(`[tool-turbo] ${message}`)
		else console.info(`[tool-turbo] ${message}`)
	}

	function sessionIdOf(agent) {
		const id = agent?.session?.id ?? agent?.id
		return typeof id === 'string' && id !== '' ? id : undefined
	}

	function remember(agent) {
		const sid = sessionIdOf(agent)
		if (sid !== undefined) agents.set(sid, agent)
	}

	ctx.on('agent/status', (payload) => {
		if (payload?.agent !== undefined) remember(payload.agent)
	})
	ctx.on('agent/created', (payload) => {
		if (payload?.agent !== undefined) remember(payload.agent)
	})
	ctx.on('agent/disposed', (payload) => {
		const sid = sessionIdOf(payload?.agent)
		if (sid === undefined) return
		agents.delete(sid)
		originals.delete(sid)
		samples.delete(sid)
	})
	// Страховка: агент мог существовать до загрузки плагина (HMR, повторный enable).
	ctx.on('agent/pre-step', (payload, next) => {
		if (payload?.agent !== undefined) remember(payload.agent)
		return next()
	})

	ctx.on('session/event', (session, event) => {
		const sid = typeof session?.id === 'string' ? session.id : undefined
		if (sid === undefined || event === undefined) return
		if (event.type === 'assistant/message') enqueue(sid, () => onAssistant(sid, event))
		else if (event.type === 'turn/end') enqueue(sid, () => restore(sid))
	})

	/**
	 * Сериализовать асинхронную работу по сессии: события приходят пачками,
	 * а записи `model/selection` должны идти в том же порядке.
	 * @param {string} sid - id сессии.
	 * @param {() => Promise<void>} work - задача.
	 */
	function enqueue(sid, work) {
		const previous = chains.get(sid) ?? Promise.resolve()
		const next = previous.then(work, work).catch((error) => {
			log(`ошибка: ${error instanceof Error ? error.message : String(error)}`)
		})
		chains.set(sid, next)
		next.then(() => {
			if (chains.get(sid) === next) chains.delete(sid)
		})
	}

	/**
	 * Каталог уровней размышления маршрута, с кэшем по provider/model.
	 * @param {string} provider - маршрут.
	 * @param {string} model - модель.
	 * @returns {Promise<{efforts: string[], defaultEffort?: string} | undefined>}
	 */
	async function catalogFor(provider, model) {
		const key = `${provider}/${model}`
		if (catalog.has(key)) return catalog.get(key)
		let value
		try {
			const info = await ctx.llm.resolveModelInfo(provider, model)
			const efforts = Array.isArray(info?.reasoning?.efforts)
				? info.reasoning.efforts
					.map((entry) => (typeof entry === 'string' ? entry : entry?.id))
					.filter((id) => typeof id === 'string' && id !== '')
				: []
			value = {
				efforts,
				...(typeof info?.reasoning?.defaultEffort === 'string' ? { defaultEffort: info.reasoning.defaultEffort } : {})
			}
		} catch (error) {
			value = { efforts: [], error: error instanceof Error ? error.message : String(error) }
		}
		catalog.set(key, value)
		return value
	}

	/**
	 * Реакция на durable assistant-сообщение.
	 * @param {string} sid - id сессии.
	 * @param {{data?: {message?: unknown}}} event - session/event.
	 */
	async function onAssistant(sid, event) {
		const agent = agents.get(sid)
		if (agent === undefined) return
		const calls = toolCallsOf(event?.data?.message)
		const accumulated = (samples.get(sid) ?? []).concat(calls)
		samples.set(sid, trimWindow(accumulated, cfg.window))
		if (calls.length === 0) {
			await restore(sid)
			return
		}
		const current = agent.model.current?.()
		if (current === undefined || current === null) return
		const info = await catalogFor(current.provider, current.model)
		if (info === undefined || info.efforts.length === 0) return
		const target = decideTarget(samples.get(sid), cfg)
		if (target === 'keep') {
			await restore(sid)
			return
		}
		const original = originals.get(sid)
		const baselineId = original?.reasoningEffort ?? current.reasoningEffort ?? info.defaultEffort ?? cfg.baseline
		const baseline = strengthOf(baselineId)
		const wanted = target === 'cheap' ? 'low' : 'max'
		const chosen = pickEffort(info.efforts, wanted, target === 'cheap' ? 'lower' : 'higher')
		if (chosen === undefined || chosen === current.reasoningEffort) return
		const chosenStrength = strengthOf(chosen)
		// Не двигаем усилие в сторону, которую пользователь запретил или которая
		// противоречит его базовому выбору (например, baseline уже 'off').
		if (baseline !== undefined && chosenStrength !== undefined) {
			if (target === 'cheap' && chosenStrength >= baseline) return
			if (target === 'deep' && chosenStrength <= baseline) return
		}
		if (original === undefined) originals.set(sid, { ...current })
		agent.model.select({
			provider: current.provider,
			model: current.model,
			reasoningEffort: chosen
		})
		log(`${target}: ${baselineId} -> ${chosen} (calls=${calls.length}, provider=${current.provider}/${current.model})`)
	}

	/**
	 * Вернуть выбор пользователя, если усилие подменял этот плагин.
	 * @param {string} sid - id сессии.
	 */
	async function restore(sid) {
		const original = originals.get(sid)
		if (original === undefined) return
		const agent = agents.get(sid)
		if (agent === undefined) {
			originals.delete(sid)
			return
		}
		const current = agent.model.current?.()
		if (current === undefined || current === null) return
		// Пользователь сменил маршрут сам — не перетираем его выбор.
		if (current.provider !== original.provider || current.model !== original.model) {
			originals.delete(sid)
			return
		}
		originals.delete(sid)
		if ((current.reasoningEffort ?? null) === (original.reasoningEffort ?? null)) return
		agent.model.select(original)
		log(`restore: ${current.reasoningEffort ?? 'default'} -> ${original.reasoningEffort ?? 'default'}`)
	}
}

/**
 * Привести конфигурацию к известным полям и типам.
 * @param {unknown} config - то, что передал загрузчик.
 * @returns {Partial<typeof DEFAULT_CONFIG>}
 */
function normalize(config) {
	if (config === null || typeof config !== 'object') return {}
	const source = /** @type {Record<string, unknown>} */ (config)
	const result = {}
	if (typeof source.enabled === 'boolean') result.enabled = source.enabled
	if (typeof source.allowDowngrade === 'boolean') result.allowDowngrade = source.allowDowngrade
	if (typeof source.allowUpgrade === 'boolean') result.allowUpgrade = source.allowUpgrade
	if (typeof source.baseline === 'string' && source.baseline !== '') result.baseline = source.baseline
	if (Number.isInteger(source.window) && source.window > 0) result.window = source.window
	return result
}
