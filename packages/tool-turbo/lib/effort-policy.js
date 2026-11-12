/**
 * Чистая политика выбора reasoning effort для плагина tool-turbo.
 *
 * Никаких импортов хоста: только входы -> выходы, чтобы политику можно было
 * покрыть юнит-тестами через `node --test`.
 *
 * Идея (унаследована от dsh-tool-turbo): узкое место шага с инструментами —
 * фаза размышления модели, а не сама команда. Если текущий раунд инструментов
 * дешёвый и детерминированный, следующий запрос можно отправить с низким
 * усилием размышления; если аргументы тяжёлые — наоборот, поднять.
 *
 * Уровни размышления задаёт провайдер, поэтому их id НЕ хардкодятся:
 * `pickEffort` получает список доступных id из `llm.resolveModelInfo` и
 * выбирает ближайший по шкале силы. Нативный DeepSeek отдаёт
 * off/low/high/max, pi-ai-маршруты — off/minimal/low/medium/high/xhigh/max.
 */

/** Шкала силы уровней: больше — дольше и умнее. */
export const STRENGTH = {
	off: 0,
	none: 0,
	minimal: 1,
	low: 2,
	medium: 3,
	high: 4,
	xhigh: 5,
	max: 6
}

/** Инструменты, которые обычно дешёвы и детерминированы. */
export const SIMPLE_TOOL_RE = /^(fs|bash|pwsh|terminal|shell|exec|code|text|todo|job|skill|read|list|search|write|grep|glob|edit|ls|cat|rm|mv|cp|touch|mkdir|pwd|head|tail)/i

/** Тяжёлые аргументы считаются сложной работой независимо от имени инструмента. */
export const HEAVY_ARGS = 800

/**
 * Сила уровня по его id.
 * @param {unknown} id - id уровня из каталога провайдера.
 * @returns {number | undefined} сила, либо undefined для незнакомого id.
 */
export function strengthOf(id) {
	if (typeof id !== 'string' || id === '') return undefined
	const key = id.toLowerCase()
	return Object.hasOwn(STRENGTH, key) ? STRENGTH[key] : undefined
}

/**
 * Достать выборки инструментов из одного assistant-сообщения.
 * Блок tool-call в dsh 0.2.2: { type: 'tool-call', id, name, arguments }.
 * @param {unknown} message - durable assistant/message.
 * @returns {{name: string, argsSize: number}[]}
 */
export function toolCallsOf(message) {
	const content = Array.isArray(message?.content) ? message.content : []
	const calls = []
	for (const block of content) {
		if (block?.type !== 'tool-call') continue
		const name = typeof block.name === 'string' && block.name !== '' ? block.name : 'tool'
		const argsSize = typeof block.arguments === 'string' ? block.arguments.length : 0
		calls.push({ name, argsSize })
	}
	return calls
}

/**
 * Доля дешёвых вызовов среди недавних.
 * @param {{name: string, argsSize: number}[]} calls - выборки.
 * @returns {number} доля от 0 до 1.
 */
export function simpleRatio(calls) {
	if (!Array.isArray(calls) || calls.length === 0) return 1
	let simple = 0
	for (const call of calls) {
		if (SIMPLE_TOOL_RE.test(call.name) && (call.argsSize ?? 0) < HEAVY_ARGS) simple += 1
	}
	return simple / calls.length
}

/**
 * Куда двигать усилие для следующего запроса.
 * @param {{name: string, argsSize: number}[]} calls - недавние вызовы.
 * @param {{allowDowngrade?: boolean, allowUpgrade?: boolean}} [options] - разрешения пользователя.
 * @returns {'cheap' | 'deep' | 'keep'}
 */
export function decideTarget(calls, options = {}) {
	const { allowDowngrade = true, allowUpgrade = false } = options
	if (!Array.isArray(calls) || calls.length === 0) return 'keep'
	const ratio = simpleRatio(calls)
	let heaviest = 0
	for (const call of calls) heaviest = Math.max(heaviest, call.argsSize ?? 0)
	if (allowDowngrade && ratio >= 0.75) return 'cheap'
	if (allowUpgrade && heaviest >= HEAVY_ARGS * 4) return 'deep'
	return 'keep'
}

/**
 * Ближайший доступный уровень к желаемому по шкале силы.
 *
 * @param {readonly string[]} available - id, которые реально предлагает провайдер.
 * @param {string} wanted - желаемый id (например 'low' или 'max').
 * @param {'lower' | 'higher'} [prefer] - как разрешать равное расстояние.
 * @returns {string | undefined} выбранный id, либо undefined, если выбрать не из чего.
 */
export function pickEffort(available, wanted, prefer = 'lower') {
	const list = Array.isArray(available) ? available.filter((id) => typeof id === 'string' && id !== '') : []
	if (list.length === 0) return undefined
	const wantedStrength = strengthOf(wanted)
	if (wantedStrength === undefined) return undefined
	const candidates = []
	for (const [index, id] of list.entries()) {
		const strength = strengthOf(id)
		if (strength === undefined) continue
		candidates.push({ id, strength, index })
	}
	if (candidates.length === 0) return undefined
	candidates.sort((left, right) => {
		const distance = Math.abs(left.strength - wantedStrength) - Math.abs(right.strength - wantedStrength)
		if (distance !== 0) return distance
		if (prefer === 'higher') return right.strength - left.strength
		return left.strength - right.strength
	})
	return candidates[0].id
}

/**
 * Оставить только последние N выборок.
 * @param {{name: string, argsSize: number}[]} calls - накопленные выборки.
 * @param {number} window - сколько хранить.
 * @returns {{name: string, argsSize: number}[]}
 */
export function trimWindow(calls, window) {
	const size = Number.isInteger(window) && window > 0 ? window : 8
	return calls.length <= size ? calls : calls.slice(-size)
}
