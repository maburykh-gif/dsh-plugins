window.__ModuleLoader__.load({
	id: "@dsh-plugins/pause-ru",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		let react_jsx_runtime = require("react/jsx-runtime");
		//#region src/client/PauseBar.tsx
		/**
* pause-ru (русский форк dsh-pause): элемент управления паузой в строке
* инструментов composer,
* слот conversation.input.right.
*
* Возможности:
* - Кнопка-переключатель: общий выключатель паузы для текущей сессии.
* - Пока пауза включена, «голый» Enter в основном поле ввода отдаётся хосту:
*   если есть точка паузы — продолжить и вложить реплику; если точки нет —
*   сразу steer; недоставленное содержимое сохраняется, а не возвращается в поле.
* - Если модель простаивает и поле пустое, двойной Enter принудительно
*   продолжает: хост получает пустое сообщение runtime-контекста, пользовательской
*   вести нет, модели просто предлагается ещё один запрос.
* - Пока пауза выключена, клавиши не перехватываются вообще.
*
* Enter в composer обрабатывается приватной клавиатурной картой InputBar,
* официальной точки расширения нет, поэтому при включённой паузе компонент
* вешает capture-phase keydown на document для своей карточки composer
* и перехватывает голый Enter раньше Lexical.
*
* @module @dsh-plugins/pause-ru/client
*/
		const DOUBLE_ENTER_MS = 600;
		async function fetchStatus(rpc, sessionId) {
			try {
				const result = await rpc.call("/pause-ru", "status", { sessionId });
				if (result.ok) return result.value;
				return;
			} catch {
				return;
			}
		}
		async function callRelease(rpc, sessionId, text, images) {
			try {
				const result = await rpc.call("/pause-ru", "release", {
					sessionId,
					text,
					images
				});
				if (!result.ok) return {
					released: false,
					delivered: false,
					error: result.error?.message ?? "Не удалось возобновить"
				};
				const value = result.value;
				return {
					released: value?.released === true,
					delivered: value?.delivered === true
				};
			} catch (error) {
				return {
					released: false,
					delivered: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		async function callContinue(rpc, sessionId) {
			try {
				const result = await rpc.call("/pause-ru", "continue", { sessionId });
				if (!result.ok) return {
					started: false,
					error: result.error?.message ?? "Не удалось продолжить принудительно"
				};
				const value = result.value;
				return {
					started: value?.started === true,
					reason: value?.reason
				};
			} catch (error) {
				return {
					started: false,
					error: error instanceof Error ? error.message : String(error)
				};
			}
		}
		async function callSetEnabled(rpc, sessionId, enabled) {
			try {
				await rpc.call("/pause-ru", "setEnabled", {
					sessionId,
					enabled
				});
			} catch {}
		}
		/**
		* 把一次回车交给主机裁决：有暂停点就放行，没有暂停点则由主机立即 steer。
		* 按下回车时文字与图片已经离开输入框，所以任何失败都不回填，改为暂存到下次发送时优先带出。
		*/
		async function releaseInterjection(rpc, sessionId, draft, carried, attachmentsPromise, onUnsent, onDone, onError) {
			let attachments = carried;
			if (attachmentsPromise !== void 0) try {
				attachments = [...carried, ...await attachmentsPromise];
			} catch (error) {
				onUnsent(draft, carried);
				onError("Вложения нельзя отправить с репликой — текст сохранён: " + (error instanceof Error ? error.message : String(error)));
				return;
			}
			if (attachments.some((part) => part.type !== "image")) {
				onUnsent(draft, carried);
				onError("Файловые вложения нельзя отправить с репликой — убраны из поля ввода, текст сохранён");
				return;
			}
			const hasPayload = draft.trim() !== "" || attachments.length > 0;
			const outcome = await callRelease(rpc, sessionId, draft, attachments);
			if (outcome.error !== void 0) {
				onUnsent(draft, attachments);
				onError(outcome.error + " — сохранено, уйдёт со следующим сообщением");
				return;
			}
			if (outcome.released || outcome.delivered) {
				onDone();
				return;
			}
			if (!hasPayload) {
				onDone();
				return;
			}
			onUnsent(draft, attachments);
			onError("Реплику не удалось доставить хосту — она сохранена и уйдёт со следующим сообщением");
		}
		/**
		* 暂停图标：两条竖线，单色 currentColor 跟随主题。
		*/
		function PauseIcon() {
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("svg", {
				viewBox: "0 0 16 16",
				width: 12,
				height: 12,
				fill: "currentColor",
				"aria-hidden": "true",
				style: { flex: "none" },
				children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: 3.6,
					y: 2.4,
					width: 3.4,
					height: 11.2,
					rx: 1.2
				}), /* @__PURE__ */ (0, react_jsx_runtime.jsx)("rect", {
					x: 9,
					y: 2.4,
					width: 3.4,
					height: 11.2,
					rx: 1.2
				})]
			});
		}
		/**
		* 暂停控件。开关开启期间挂 document capture 拦截裸 Enter，落点在本 composer 卡内时交给主机裁决。
		*/
		const PauseControl = (0, react.memo)(function PauseControl({ rpc, sessionId, useInput, inputActions, serializeAttachments, releaseAttachment }) {
			const [enabled, setEnabled] = (0, react.useState)(false);
			const [paused, setPaused] = (0, react.useState)(false);
			const [error, setError] = (0, react.useState)(void 0);
			const [hint, setHint] = (0, react.useState)(void 0);
			const rootRef = (0, react.useRef)(null);
			const missingCardWarnedRef = (0, react.useRef)(false);
			const draft = useInput((state) => state.draft);
			const attachmentIds = useInput((state) => state.attachmentIds);
			const draftRef = (0, react.useRef)(draft);
			draftRef.current = draft;
			const idsRef = (0, react.useRef)(attachmentIds);
			idsRef.current = attachmentIds;
			const phase = useInput((state) => state.phase);
			const phaseRef = (0, react.useRef)(phase);
			phaseRef.current = phase;
			const pausePointRef = (0, react.useRef)({ release: () => {} });
			const pausedRef = (0, react.useRef)(false);
			pausedRef.current = paused;
			const lastEmptyEnterRef = (0, react.useRef)(0);
			const forcingRef = (0, react.useRef)(false);
			const forceContinueRef = (0, react.useRef)(() => {});
			const hintTimerRef = (0, react.useRef)(void 0);
			const toggleRef = (0, react.useRef)(() => {});
			const releasingRef = (0, react.useRef)(false);
			const deferredRef = (0, react.useRef)(false);
			const claimedRef = (0, react.useRef)(/* @__PURE__ */ new Set());
			const unsentRef = (0, react.useRef)([]);
			pausePointRef.current = { release: () => {
				if (releasingRef.current) {
					deferredRef.current = true;
					return;
				}
				if (phaseRef.current === "adjudicating" || phaseRef.current === "submitting") {
					setError("Предыдущее сообщение ещё отправляется — нажмите Enter чуть позже");
					return;
				}
				setError(void 0);
				const carried = unsentRef.current;
				unsentRef.current = [];
				const carriedText = carried.map((item) => item.text.trim()).filter((text) => text !== "").join("\n");
				const current = draftRef.current;
				const sent = carriedText === "" ? current : current === "" ? carriedText : carriedText + "\n" + current;
				const carriedImages = carried.flatMap((item) => item.images);
				const ids = idsRef.current.filter((id) => !claimedRef.current.has(id));
				if (ids.length > 0 && serializeAttachments === void 0) {
					unsentRef.current = carried;
					setError("В этом окружении вложения с репликой не поддерживаются: текст сохранён, картинки нужно убрать");
					return;
				}
				releasingRef.current = true;
				for (const id of ids) claimedRef.current.add(id);
				const serialization = ids.length === 0 || serializeAttachments === void 0 ? void 0 : serializeAttachments(ids);
				draftRef.current = "";
				inputActions?.setDraft("");
				for (const id of ids) inputActions?.removeAttachment(id);
				releaseInterjection(rpc, sessionId, sent, carriedImages, serialization, (text, images) => {
					unsentRef.current.push({
						text,
						images
					});
				}, () => setPaused(false), (message) => {
					deferredRef.current = false;
					setError(message);
				}).finally(() => {
					releasingRef.current = false;
					for (const id of ids) {
						claimedRef.current.delete(id);
						releaseAttachment?.(id);
					}
					if (deferredRef.current) {
						deferredRef.current = false;
						pausePointRef.current.release();
					}
				});
			} };
			forceContinueRef.current = () => {
				if (forcingRef.current) return;
				forcingRef.current = true;
				setError(void 0);
				callContinue(rpc, sessionId).then((outcome) => {
					if (outcome.error !== void 0) setError(outcome.error);
					else if (!outcome.started) setError(outcome.reason === "busy" ? "Модель работает — дождитесь остановки и нажмите Enter дважды" : "Не удалось продолжить работу модели");
				}).finally(() => {
					forcingRef.current = false;
				});
			};
			(0, react.useEffect)(() => {
				let disposed = false;
				let timer;
				const poll = async () => {
					const s = await fetchStatus(rpc, sessionId);
					if (disposed || s === void 0) return;
					setEnabled(s.enabled ?? false);
					setPaused(s.paused ?? false);
				};
				poll();
				timer = setInterval(() => void poll(), 400);
				return () => {
					disposed = true;
					if (timer !== void 0) clearInterval(timer);
				};
			}, [rpc, sessionId]);
			(0, react.useEffect)(() => {
				if (!enabled) return;
				const clearHint = () => {
					if (hintTimerRef.current !== void 0) {
						clearTimeout(hintTimerRef.current);
						hintTimerRef.current = void 0;
					}
					setHint(void 0);
				};
				const showHint = () => {
					clearHint();
					setHint("Нажмите Enter ещё раз, чтобы продолжить");
					hintTimerRef.current = setTimeout(() => {
						hintTimerRef.current = void 0;
						setHint(void 0);
					}, DOUBLE_ENTER_MS);
				};
				const onCapture = (event) => {
					if (event.key !== "Enter" || event.shiftKey || event.ctrlKey || event.metaKey) return;
					if (event.isComposing || event.keyCode === 229) return;
					const root = rootRef.current;
					if (root === null || !root.isConnected) return;
					const card = root.closest("[data-composer-card]");
					if (card === null) {
						if (!missingCardWarnedRef.current) {
							missingCardWarnedRef.current = true;
							console.warn("[pause-ru] не найден [data-composer-card]: перехват Enter не работает; возможно, в этой версии DSH изменилась структура composer");
						}
						return;
					}
					missingCardWarnedRef.current = false;
					if (!card.contains(event.target)) return;
					event.preventDefault();
					event.stopPropagation();
					if (pausedRef.current) {
						lastEmptyEnterRef.current = 0;
						clearHint();
						pausePointRef.current.release();
						return;
					}
					if (!(draftRef.current.trim() === "" && idsRef.current.length === 0)) {
						lastEmptyEnterRef.current = 0;
						clearHint();
						pausePointRef.current.release();
						return;
					}
					const now = Date.now();
					if (now - lastEmptyEnterRef.current > DOUBLE_ENTER_MS) {
						lastEmptyEnterRef.current = now;
						showHint();
						pausePointRef.current.release();
						return;
					}
					lastEmptyEnterRef.current = 0;
					clearHint();
					forceContinueRef.current();
				};
				document.addEventListener("keydown", onCapture, true);
				return () => {
					if (hintTimerRef.current !== void 0) {
						clearTimeout(hintTimerRef.current);
						hintTimerRef.current = void 0;
					}
					setHint(void 0);
					document.removeEventListener("keydown", onCapture, true);
				};
			}, [enabled, sessionId]);
			const toggle = async (next) => {
				setError(void 0);
				setEnabled(next);
				await callSetEnabled(rpc, sessionId, next);
			};
			toggleRef.current = () => {
				toggle(!enabled);
			};
			(0, react.useEffect)(() => {
				const onPauseKey = (event) => {
					if (event.key !== "Pause" && event.code !== "Pause") return;
					event.preventDefault();
					event.stopPropagation();
					toggleRef.current();
				};
				document.addEventListener("keydown", onPauseKey, true);
				return () => document.removeEventListener("keydown", onPauseKey, true);
			}, []);
			return /* @__PURE__ */ (0, react_jsx_runtime.jsxs)("div", {
				ref: rootRef,
				"data-pause-ru": "true",
				style: {
					display: "inline-flex",
					alignItems: "center",
					gap: "6px",
					padding: "0 4px",
					fontSize: "12px",
					lineHeight: "20px",
					whiteSpace: "nowrap",
					color: "var(--dsw-alias-label-secondary)"
				},
				children: [
					/* @__PURE__ */ (0, react_jsx_runtime.jsxs)("button", {
						type: "button",
						"aria-pressed": enabled,
						title: enabled ? "Пауза включена" : "Включить паузу: остановка перед следующим шагом с инструментами",
						onClick: () => {
							toggle(!enabled);
						},
						style: {
							cursor: "pointer",
							border: "1px solid var(--dsw-alias-border-l2)",
							borderRadius: "6px",
							background: enabled ? "var(--dsw-alias-state-business-primary)" : "transparent",
							color: enabled ? "var(--dsw-alias-label-primary-inverted)" : "var(--dsw-alias-label-secondary)",
							padding: "1px 8px",
							fontSize: "12px",
							lineHeight: "18px",
							display: "inline-flex",
							alignItems: "center",
							gap: "4px"
						},
						children: [/* @__PURE__ */ (0, react_jsx_runtime.jsx)(PauseIcon, {}), enabled ? "Пауза вкл." : "Пауза"]
					}),
					paused && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("button", {
						type: "button",
						onClick: () => {
							pausePointRef.current.release();
						},
						style: {
							cursor: "pointer",
							border: "1px solid var(--dsw-alias-state-business-primary)",
							borderRadius: "6px",
							background: "var(--dsw-alias-state-business-primary)",
							color: "var(--dsw-alias-label-primary-inverted)",
							padding: "1px 8px",
							fontSize: "12px",
							lineHeight: "18px"
						},
						children: "Приостановлено · Enter или клик — продолжить"
					}),
					hint !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							color: "var(--dsw-alias-label-secondary)",
							fontSize: "12px"
						},
						children: hint
					}),
					error !== void 0 && /* @__PURE__ */ (0, react_jsx_runtime.jsx)("span", {
						style: {
							color: "var(--dsw-alias-label-error, #d9534f)",
							fontSize: "12px"
						},
						children: error
					})
				]
			});
		});
		//#endregion
		//#region src/client/index.ts
		/** 插件名即配置项 id。 */
		const name = "pause-ru";
		/** 本插件需要的客户端服务。conversation 用于把草稿附件序列化成可随插话提交的载荷。 */
		const inject = [
			"slots",
			"connection",
			"conversation"
		];
		/**
		* 把暂停控件注册进 composer 工具行右侧。
		* @param ctx 客户端根上下文。
		*/
		function apply(ctx) {
			const connection = ctx.connection;
			const conversation = ctx.conversation;
			ctx.slots.inject("conversation.input.right", () => ctx.slots.register({
				name: "conversation.input.right",
				id: "@dsh-plugins/pause-ru",
				order: 30,
				inject: () => ({
					rpc: connection.rpc,
					serializeAttachments: async (ids) => {
						if (conversation.resolveDraftAttachments(ids).some((draft) => draft.kind !== "image")) throw new Error("Файловые вложения нельзя отправить с репликой — выберите заново");
						return (await conversation.serializeDraftAttachments(ids)).attachments;
					},
					releaseAttachment: (id) => {
						conversation.releaseDraftAttachment(id);
					}
				})
			}, PauseControl));
		}
		//#endregion
		exports.PauseControl = PauseControl;
		exports.apply = apply;
		exports.inject = inject;
		exports.name = name;
		return module.exports;
	}
});
