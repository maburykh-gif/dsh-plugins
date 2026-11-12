import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
	decideTarget,
	pickEffort,
	simpleRatio,
	strengthOf,
	toolCallsOf,
	trimWindow
} from '../lib/effort-policy.js'

const DEEPSEEK = ['off', 'low', 'high', 'max']
const PIAI = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']

test('strengthOf знает шкалу и не выдумывает чужие id', () => {
	assert.equal(strengthOf('off'), 0)
	assert.equal(strengthOf('low'), 2)
	assert.equal(strengthOf('MAX'), 6)
	assert.equal(strengthOf('deep-think'), undefined)
	assert.equal(strengthOf(undefined), undefined)
})

test('toolCallsOf берёт только tool-call блоки', () => {
	const message = {
		content: [
			{ type: 'text', text: 'думаю' },
			{ type: 'tool-call', id: 'a', name: 'bash', arguments: '{"command":"ls"}' },
			{ type: 'tool-call', id: 'b', name: 'fs_read', arguments: '' }
		]
	}
	assert.deepEqual(toolCallsOf(message), [
		{ name: 'bash', argsSize: 16 },
		{ name: 'fs_read', argsSize: 0 }
	])
	assert.deepEqual(toolCallsOf({ content: [{ type: 'text', text: 'итог' }] }), [])
	assert.deepEqual(toolCallsOf(undefined), [])
})

test('simpleRatio: пустой раунд считается простым, тяжёлые аргументы портят долю', () => {
	assert.equal(simpleRatio([]), 1)
	assert.equal(simpleRatio([{ name: 'bash', argsSize: 10 }, { name: 'read', argsSize: 20 }]), 1)
	assert.equal(simpleRatio([{ name: 'bash', argsSize: 10 }, { name: 'web_search', argsSize: 20 }]), 0.5)
	assert.equal(simpleRatio([{ name: 'bash', argsSize: 5000 }]), 0)
})

test('decideTarget: политика понижения/повышения', () => {
	const simple = [{ name: 'bash', argsSize: 40 }, { name: 'grep', argsSize: 12 }]
	const heavy = [{ name: 'fs_write', argsSize: 9000 }]
	const mixed = [{ name: 'bash', argsSize: 10 }, { name: 'web_search', argsSize: 50 }]

	assert.equal(decideTarget([]), 'keep')
	assert.equal(decideTarget(simple, { allowDowngrade: true }), 'cheap')
	assert.equal(decideTarget(simple, { allowDowngrade: false }), 'keep')
	assert.equal(decideTarget(heavy, { allowUpgrade: true }), 'deep')
	assert.equal(decideTarget(heavy, { allowUpgrade: false }), 'keep')
	assert.equal(decideTarget(mixed, { allowUpgrade: true, allowDowngrade: true }), 'keep')
})

test('pickEffort: ближайший доступный уровень, без чужих id', () => {
	assert.equal(pickEffort(DEEPSEEK, 'low'), 'low')
	assert.equal(pickEffort(DEEPSEEK, 'max'), 'max')
	assert.equal(pickEffort(PIAI, 'low'), 'low')
	assert.equal(pickEffort(PIAI, 'max'), 'max')
	// minimal ближе к low, чем high
	assert.equal(pickEffort(['minimal', 'high'], 'low'), 'minimal')
	// при равном расстоянии направление задаёт вызывающий
	assert.equal(pickEffort(['off', 'high'], 'low', 'lower'), 'off')
	assert.equal(pickEffort(['off', 'high'], 'low', 'higher'), 'high')
	assert.equal(pickEffort([], 'low'), undefined)
	assert.equal(pickEffort(['custom-level'], 'low'), undefined)
})

test('trimWindow держит только последние N выборок', () => {
	const calls = [{ name: 'a', argsSize: 1 }, { name: 'b', argsSize: 2 }, { name: 'c', argsSize: 3 }]
	assert.deepEqual(trimWindow(calls, 2), [{ name: 'b', argsSize: 2 }, { name: 'c', argsSize: 3 }])
	assert.deepEqual(trimWindow(calls, 10), calls)
	assert.equal(trimWindow(calls, 0).length, 3)
})
