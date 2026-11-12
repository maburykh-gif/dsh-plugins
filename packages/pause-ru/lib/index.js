import z from "@deepseek-ai/schemastery";
import { createUserMessage } from "@deepseek-ai/dsh-llm";
//#region src/controller.ts
/**
* 判定一次 pre-step 是否应当触发暂停。
*
* 纯函数，便于单测。
* dsh 的 driver 把一个模型请求当作一个 step。用户首条消息进入的 step 记为 turn 内的第 1 步。
* 模型在某个 step 里请求工具后，工具结果写回，driver 会为带工具结果的下一模型请求再开一个新 step，路径为 tools → pre-step → step。
* 因此一次工具交互后的续跑请求可用同一 turn 内 step 大于 1 来近似。此启发式无法区分工具续跑与人类中途插话造成的新 step，会把二者都视为续跑。
* 对暂停语用而言，二者都是模型进一步作答前的一个暂停点，行为可接受。每个 turn 的第一次请求 step 等于 1，永不触发暂停。
*
* @param enabled 该会话开关是否开启。
* @param step 本次 pre-step 的 step 序号，为 turn 内序号。
* @returns 本次 pre-step 是否应暂停。
*/
function shouldPause(enabled, step) {
	return enabled && step > 1;
}
/**
* 把一段补充文字转成要并进 step 的 user 消息。空文字不产生消息。
* 带图插话由安装器先经附件服务持久化，再调用本函数无法表达，故只处理纯文字。
* @param text 人类输入的补充文字。
* @returns 待并入的 user 消息；空白文字返回 undefined。
*/
function textToMessage(text) {
	const trimmed = text.trim();
	if (trimmed === "") return void 0;
	return createUserMessage({
		content: [{
			type: "text",
			text: trimmed
		}],
		source: { kind: "user" }
	});
}
/**
* 构造一次「强制继续」的唤醒消息：内容为空，来源为运行时上下文。
*
* loop 进入 step 时会把来源为该 kind 的消息替换成它自己的运行时上下文快照，因此这条消息本身不会落进会话，会话里也不会出现用户消息；模型请求仍照常发出，相当于让模型对着现有上下文再答一次。
* @returns 待 followup 的唤醒消息。
*/
function createContinueMessage() {
	return createUserMessage({
		content: [],
		source: { kind: "runtime-context" }
	});
}
/** 会话状态在安装器里的默认初始值。 */
function initialSessionState() {
	return {
		enabled: false,
		pausePoint: void 0
	};
}
/** 默认每会话开关。 */
const DEFAULT_ENABLED = false;
/**
* 会话状态表，以 session id 为键存放每个会话的开关与暂停点。
* 同一会话的 pre-step 与 release 串行访问，单线程无需加锁。
*/
var PauseRegistry = class {
	defaultEnabled;
	states = /* @__PURE__ */ new Map();
	constructor(defaultEnabled = false) {
		this.defaultEnabled = defaultEnabled;
	}
	stateFor(sessionId) {
		let s = this.states.get(sessionId);
		if (s === void 0) {
			s = {
				...initialSessionState(),
				enabled: this.defaultEnabled
			};
			this.states.set(sessionId, s);
		}
		return s;
	}
	setEnabled(sessionId, enabled) {
		this.states.set(sessionId, {
			...this.stateFor(sessionId),
			enabled
		});
	}
	/** 会话开关当前值。 */
	enabled(sessionId) {
		return this.stateFor(sessionId).enabled;
	}
	/** 是否已暂停，即当前挂着一个在等放行的暂停点。 */
	isPaused(sessionId) {
		return this.stateFor(sessionId).pausePoint !== void 0;
	}
	/**
	* 放行暂停点。若该会话当前正挂着暂停点，用给定补充消息放行并返回 true；否则返回 false。
	* 放行后状态复位为未暂停，因为这一步已经放行。
	*/
	release(sessionId, message) {
		const s = this.stateFor(sessionId);
		if (s.pausePoint === void 0) return false;
		const resolve = s.pausePoint.resolve;
		this.states.set(sessionId, {
			...s,
			pausePoint: void 0
		});
		resolve(message);
		return true;
	}
	/** 挂起一个暂停点，并把放行入口写入状态。 */
	armPausePoint(sessionId, resolvers) {
		const s = this.stateFor(sessionId);
		this.states.set(sessionId, {
			...s,
			pausePoint: {
				resolve: resolvers.resolve,
				reject: resolvers.reject
			}
		});
	}
	/** 中止等待中的暂停点，例如 turn 被取消时。返回是否确有被中止的暂停点。 */
	abortPausePoint(sessionId, reason) {
		const s = this.stateFor(sessionId);
		if (s.pausePoint === void 0) return false;
		const reject = s.pausePoint.reject;
		this.states.set(sessionId, {
			...s,
			pausePoint: void 0
		});
		reject(reason);
		return true;
	}
};
//#endregion
//#region src/rpc-channel.ts
/** 端点路径段的合法字符集，与官方 ENDPOINT_SEGMENT_PATTERN 一致。 */
const SEGMENT = /^[A-Za-z0-9_$.-]+$/;
/** 请求体上限，与官方 maxRequestBodyBytes 默认值一致；图片插话随请求传 base64，需给足空间。 */
const MAX_BODY_BYTES = 314572800;
/** 唯一接受的 content-type，与官方信封契约一致。 */
const JSON_MIME = "application/json";
/** 请求体超限的标记错误，由 serve 决定如何回写与断开。 */
var PayloadTooLargeError = class extends Error {};
/**
* 挂载一条 RPC 通道。webServer 或 connection 缺席时不挂载，其余功能不受影响。
* @param ctx - 插件上下文。
* @param channel - 绝对通道前缀，例如 /dsh-pause。
* @param handler - 端点处理器。
* @param options - 挂载选项，目前只有请求体上限。
*/
function mountRpcChannel(ctx, channel, handler, options = {}) {
	const maxBodyBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
	ctx.inject(["connection", "webServer"], (raw) => {
		const scope = raw;
		scope.effect(() => scope.webServer.register({
			kind: "prefix",
			path: channel,
			handler: (req, res) => serve(scope.connection, channel, handler, maxBodyBytes, req, res)
		}), `${channel}: rpc channel`);
	});
}
/**
* 处理一次 HTTP 请求：信任与鉴权、端点解析、信封校验、结果回写。
* @param connection - connection 服务，用其信任判定。
* @param channel - 本通道前缀。
* @param handler - 端点处理器。
* @param maxBodyBytes - 请求体字节上限。
* @param req - node 请求。
* @param res - node 响应。
*/
async function serve(connection, channel, handler, maxBodyBytes, req, res) {
	const rejection = connection.requestRejection(req);
	if (rejection !== void 0) {
		res.writeHead(rejection);
		res.end(rejection === 401 ? "unauthorized" : "forbidden");
		return;
	}
	if (req.method !== "POST") return missing(res);
	const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
	const prefix = `${channel}/`;
	if (!pathname.startsWith(prefix)) return missing(res);
	const endpoint = pathname.slice(prefix.length);
	if (!endpoint.split("/").every((part) => part !== "" && part !== "." && part !== ".." && SEGMENT.test(part))) return missing(res);
	if (!isJsonContentType(req)) {
		res.writeHead(415);
		res.end("unsupported media type");
		return;
	}
	const declared = Number(req.headers["content-length"]);
	if (Number.isFinite(declared) && declared > maxBodyBytes) return tooLarge(req, res);
	let raw;
	try {
		raw = await readBody(req, maxBodyBytes);
	} catch (error) {
		if (error instanceof PayloadTooLargeError) return tooLarge(req, res);
		res.writeHead(400);
		res.end("body read failed");
		return;
	}
	let message;
	try {
		message = JSON.parse(raw);
	} catch (error) {
		res.writeHead(400);
		res.end("body is not JSON");
		return;
	}
	const rpcId = typeof message.rpcId === "string" ? message.rpcId : "invalid-request";
	if (message.type !== "client-request" || typeof message.method !== "string") return reply(res, rpcId, {
		ok: false,
		error: {
			code: "gateway/bad-request",
			message: "invalid client-request message",
			details: {}
		}
	});
	if (message.method !== endpoint) return reply(res, rpcId, {
		ok: false,
		error: {
			code: "gateway/bad-request",
			message: `method ${JSON.stringify(message.method)} does not match endpoint ${JSON.stringify(endpoint)}`,
			details: {}
		}
	});
	const controller = new AbortController();
	const onClose = () => {
		controller.abort(/* @__PURE__ */ new Error("client disconnected"));
	};
	res.on("close", onClose);
	let result;
	try {
		result = await handler(endpoint, message.payload, controller.signal);
	} catch (error) {
		result = {
			ok: false,
			error: {
				code: "internal",
				message: error instanceof Error ? error.message : String(error),
				details: {}
			}
		};
	} finally {
		res.off("close", onClose);
	}
	reply(res, rpcId, result);
}
/** 路径不匹配或方法不符时统一 404，与官方未认领端点一致。 */
function missing(res) {
	res.writeHead(404);
	res.end("not found");
}
/** 回写一个 server-response 信封。 */
function reply(res, rpcId, result) {
	res.writeHead(200, { "content-type": "application/json" });
	res.end(JSON.stringify({
		type: "server-response",
		rpcId,
		result
	}));
}
/** 先回 413 再销毁连接：顺序反了 socket 已断，413 永远发不出去。 */
function tooLarge(req, res) {
	res.writeHead(413, { connection: "close" });
	res.end("payload too large");
	req.destroy();
}
/** content-type 必须声明为 application/json，charset 等参数可忽略。 */
function isJsonContentType(req) {
	const header = req.headers["content-type"];
	if (typeof header !== "string") return false;
	const mime = header.split(";", 1)[0];
	return mime !== void 0 && mime.trim().toLowerCase() === JSON_MIME;
}
/**
* 读取并限长请求体，超限抛 PayloadTooLargeError，由调用方回写 413。
* @param req - node 请求。
* @param maxBodyBytes - 请求体字节上限。
*/
async function readBody(req, maxBodyBytes) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
		size += buffer.length;
		if (size > maxBodyBytes) throw new PayloadTooLargeError("rpc channel: request body exceeds limit");
		chunks.push(buffer);
	}
	return Buffer.concat(chunks).toString("utf8");
}
//#endregion
//#region src/index.ts
const name = "pause-ru";
/** 本插件需要的主机服务。connection 是 host 与浏览器共享的 RPC 载体，agents 用来把插话 steer 进当前 turn。 */
const inject = ["connection", "agents"];
const Config = z.object({ defaultEnabled: z.boolean().default(false) });
const IMAGE_MEDIA_TYPES = /* @__PURE__ */ new Set([
	"image/png",
	"image/jpeg",
	"image/webp",
	"image/gif"
]);
function ok(value) {
	return {
		ok: true,
		value
	};
}
function rpcError(message) {
	return {
		ok: false,
		error: {
			code: "internal",
			message,
			details: {}
		}
	};
}
/** 读取活 agent 注册表，用于把插话立即 steer 进当前 turn。 */
function agentRegistry(ctx) {
	const get = ctx.get;
	if (typeof get === "function") {
		const service = get.call(ctx, "agents", false);
		if (service !== void 0) return service;
	}
	return ctx.agents;
}
/** 读取附件服务。RPC 测试桩或裁剪运行环境可能没有它，此时带图插话会明确报错。 */
function attachmentStore(ctx) {
	const get = ctx.get;
	if (typeof get !== "function") return void 0;
	return get.call(ctx, "attachments", false);
}
/** 校验并解包浏览器送来的图片列表，非法输入直接抛错，由 RPC 层转成错误信封。 */
function readImages(raw) {
	if (raw === void 0 || raw === null) return [];
	if (!Array.isArray(raw)) throw new Error("release: images должен быть массивом");
	return raw.map((entry, index) => {
		if (entry === null || typeof entry !== "object") throw new Error(`release: images[${index}] должен быть объектом`);
		const { mediaType, data, name } = entry;
		if (typeof mediaType !== "string" || !IMAGE_MEDIA_TYPES.has(mediaType)) throw new Error(`release: images[${index}] — неподдерживаемый медиатип`);
		if (typeof data !== "string" || data === "") throw new Error(`release: images[${index}] — отсутствуют base64-данные`);
		if (name !== void 0 && typeof name !== "string") throw new Error(`release: images[${index}] — имя файла должно быть строкой`);
		const part = {
			type: "image",
			mediaType,
			data
		};
		return name === void 0 ? part : {
			...part,
			name
		};
	});
}
/**
* 把放行时携带的文字与图片组成一条待并入的用户消息。
* 图片先经附件服务持久化，得到的持久引用随消息进入会话日志，浏览器侧的临时草稿随后释放。
* @param ctx 插件上下文，用于取附件服务。
* @param textRaw 浏览器送来的补充文字，非字符串按空处理。
* @param imagesRaw 浏览器送来的图片列表，可为空。
* @returns 待并入的用户消息；文字与图片皆空时 undefined，表示无感继续。
*/
async function buildReleaseMessage(ctx, textRaw, imagesRaw) {
	const text = typeof textRaw === "string" ? textRaw.trim() : "";
	const images = readImages(imagesRaw);
	if (text === "" && images.length === 0) return void 0;
	if (images.length === 0) return textToMessage(text);
	const store = attachmentStore(ctx);
	if (store === void 0) throw new Error("Возобновление с картинками требует сервиса вложений — в этом окружении он недоступен");
	const parts = [];
	if (text !== "") parts.push({
		type: "text",
		text
	});
	parts.push(...images);
	const content = (await store.admitPromptContent(parts)).map((part) => part.type === "text" ? {
		type: "text",
		text: part.text
	} : {
		type: part.type,
		attachment: part.attachment
	});
	return createUserMessage({
		content,
		source: { kind: "user" }
	});
}
function apply(ctx, config = {}) {
	const registry = new PauseRegistry(config.defaultEnabled === true);
	const liveAgents = /* @__PURE__ */ new Map();
	const agentFor = (sessionId) => liveAgents.get(sessionId) ?? agentRegistry(ctx)?.get(sessionId);
	const pendingSteer = /* @__PURE__ */ new Map();
	const markSteer = (sessionId, message) => {
		let ids = pendingSteer.get(sessionId);
		if (ids === void 0) {
			ids = /* @__PURE__ */ new Set();
			pendingSteer.set(sessionId, ids);
		}
		ids.add(message.id);
	};
	/** 清掉已经不在 inbox、也没随本步进来的插话，避免暂停被永久放过。 */
	const pruneSteer = (sessionId, messages) => {
		const pending = pendingSteer.get(sessionId);
		if (pending === void 0 || pending.size === 0) return void 0;
		const agent = agentFor(sessionId);
		if (agent === void 0) return pending;
		const inBatch = new Set(messages.map((message) => String(message.id)));
		const inboxIds = new Set(agent.inbox.nextStep.map((message) => String(message.id)));
		for (const id of [...pending]) {
			if (inBatch.has(id)) {
				pending.delete(id);
				continue;
			}
			if (!inboxIds.has(id)) pending.delete(id);
		}
		return pending.size > 0 ? pending : void 0;
	};
	/** 该步被 reject 时把已并入的消息重新 steer 一次，避免插件缓存或丢失。 */
	const resteer = (sessionId, message) => {
		const agent = agentFor(sessionId);
		if (agent === void 0) {
			console.error("[pause-ru] шаг отклонён, активного агента для повторного steer нет — реплика потеряна:", message);
			return;
		}
		try {
			agent.steer(message);
			markSteer(sessionId, message);
		} catch (error) {
			console.error("[pause-ru] шаг отклонён, повторный steer не удался — реплика потеряна:", error);
		}
	};
	const handler = async (endpoint, payload) => {
		try {
			switch (endpoint) {
				case "setEnabled": {
					const { sessionId, enabled } = payload;
					if (typeof sessionId !== "string" || typeof enabled !== "boolean") return rpcError("setEnabled requires sessionId:string, enabled:boolean");
					registry.setEnabled(sessionId, enabled);
					if (!enabled && registry.isPaused(sessionId)) registry.release(sessionId, void 0);
					return ok({ paused: registry.isPaused(sessionId) });
				}
				case "release": {
					const { sessionId, text, images } = payload;
					if (typeof sessionId !== "string") return rpcError("release requires sessionId:string");
					const textLength = typeof text === "string" ? text.trim().length : 0;
					const imageCount = Array.isArray(images) ? images.length : 0;
					const message = textLength === 0 && imageCount === 0 ? void 0 : await buildReleaseMessage(ctx, text, images);
					if (registry.isPaused(sessionId)) return ok({
						released: registry.release(sessionId, message),
						delivered: message !== void 0
					});
					if (message === void 0) return ok({
						released: false,
						delivered: false
					});
					const agent = agentFor(sessionId);
					if (agent === void 0) {
						console.error("[pause-ru] активный агент не найден, steer реплики невозможен:", sessionId);
						return ok({
							released: false,
							delivered: false
						});
					}
					agent.steer(message);
					markSteer(sessionId, message);
					return ok({
						released: false,
						delivered: true
					});
				}
				case "continue": {
					const { sessionId } = payload;
					if (typeof sessionId !== "string") return rpcError("continue requires sessionId:string");
					const agent = agentFor(sessionId);
					if (agent === void 0) return rpcError("активный агент не найден — принудительное продолжение невозможно");
					if (agent.status !== void 0 && agent.status !== "idle") return ok({
						started: false,
						reason: "busy"
					});
					agent.followup(createContinueMessage());
					return ok({ started: true });
				}
				case "status": {
					const { sessionId } = payload;
					if (typeof sessionId !== "string") return rpcError("status requires sessionId:string");
					return ok({
						enabled: registry.enabled(sessionId),
						paused: registry.isPaused(sessionId)
					});
				}
				default: return rpcError("unknown endpoint " + endpoint);
			}
		} catch (error) {
			return rpcError(error instanceof Error ? error.message : String(error));
		}
	};
	mountRpcChannel(ctx, "/pause-ru", handler);
	ctx.on("agent/status", (payload) => {
		liveAgents.set(payload.agent.id, payload.agent);
	});
	ctx.on("agent/pre-step", async (payload, next) => {
		const sessionId = payload.agent.id;
		liveAgents.set(sessionId, payload.agent);
		const state = registry.stateFor(sessionId);
		if (payload.step <= 1 || !state.enabled) return next();
		if (pruneSteer(sessionId, payload.messages) !== void 0) return next();
		if (payload.messages.length > 0) return next();
		const inbox = agentFor(sessionId)?.inbox;
		if (inbox !== void 0 && inbox.nextTurn.length > 0) return next();
		let resolvePausePoint = () => {};
		let rejectPausePoint = () => {};
		const pausePoint = new Promise((resolve, reject) => {
			resolvePausePoint = resolve;
			rejectPausePoint = reject;
		});
		registry.armPausePoint(sessionId, {
			resolve: resolvePausePoint,
			reject: rejectPausePoint
		});
		const onAbort = () => {
			registry.abortPausePoint(sessionId, payload.signal.reason);
		};
		if (payload.signal.aborted) onAbort();
		else payload.signal.addEventListener("abort", onAbort, { once: true });
		let carried;
		try {
			carried = await pausePoint;
		} catch {} finally {
			payload.signal.removeEventListener("abort", onAbort);
		}
		let decision;
		try {
			decision = await next();
		} catch (error) {
			if (carried !== void 0) resteer(sessionId, carried);
			throw error;
		}
		if (decision.kind === "reject") {
			if (carried !== void 0) resteer(sessionId, carried);
			return decision;
		}
		return carried === void 0 ? decision : {
			...decision,
			messages: [...decision.messages, carried]
		};
	});
}
//#endregion
export { Config, DEFAULT_ENABLED, PauseRegistry, apply, createContinueMessage, initialSessionState, inject, name, shouldPause, textToMessage };
