import z from "@deepseek-ai/schemastery";
import { ContextFormed, UserMessage } from "@deepseek-ai/dsh-llm";
import { Context } from "@deepseek-ai/cordis";
//#region src/controller.d.ts
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'runtime-context': {
      kind: 'runtime-context';
    } & ContextFormed;
  }
}
/** 一个会话的暂停开关与暂停点状态。会话以 agent 的 session id 为键。 */
interface PauseSessionState {
  /** 用户开关：该会话是否启用暂停。false 时所有请求直接放行。 */
  enabled: boolean;
  /** 当前挂着的暂停点，放行时若带文字则一并返回。 */
  pausePoint: PausePoint | undefined;
}
/** 一个暂停点：人类选择继续时用它放行，可携带一条已构造好的补充用户消息。 */
interface PausePoint {
  /** 解析放行等待的入口，参数为待并入本步的补充消息，undefined 表示无感继续。 */
  resolve: (message: UserMessage | undefined) => void;
  reject: (reason: unknown) => void;
}
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
declare function shouldPause(enabled: boolean, step: number): boolean;
/**
 * 把一段补充文字转成要并进 step 的 user 消息。空文字不产生消息。
 * 带图插话由安装器先经附件服务持久化，再调用本函数无法表达，故只处理纯文字。
 * @param text 人类输入的补充文字。
 * @returns 待并入的 user 消息；空白文字返回 undefined。
 */
declare function textToMessage(text: string): UserMessage | undefined;
/**
 * 构造一次「强制继续」的唤醒消息：内容为空，来源为运行时上下文。
 *
 * loop 进入 step 时会把来源为该 kind 的消息替换成它自己的运行时上下文快照，因此这条消息本身不会落进会话，会话里也不会出现用户消息；模型请求仍照常发出，相当于让模型对着现有上下文再答一次。
 * @returns 待 followup 的唤醒消息。
 */
declare function createContinueMessage(): UserMessage;
/** 会话状态在安装器里的默认初始值。 */
declare function initialSessionState(): PauseSessionState;
/** 默认每会话开关。 */
declare const DEFAULT_ENABLED = false;
/**
 * 会话状态表，以 session id 为键存放每个会话的开关与暂停点。
 * 同一会话的 pre-step 与 release 串行访问，单线程无需加锁。
 */
declare class PauseRegistry {
  private readonly defaultEnabled;
  private readonly states;
  constructor(defaultEnabled?: boolean);
  stateFor(sessionId: string): PauseSessionState;
  setEnabled(sessionId: string, enabled: boolean): void;
  /** 会话开关当前值。 */
  enabled(sessionId: string): boolean;
  /** 是否已暂停，即当前挂着一个在等放行的暂停点。 */
  isPaused(sessionId: string): boolean;
  /**
   * 放行暂停点。若该会话当前正挂着暂停点，用给定补充消息放行并返回 true；否则返回 false。
   * 放行后状态复位为未暂停，因为这一步已经放行。
   */
  release(sessionId: string, message: UserMessage | undefined): boolean;
  /** 挂起一个暂停点，并把放行入口写入状态。 */
  armPausePoint(sessionId: string, resolvers: Pick<PausePoint, 'resolve' | 'reject'>): void;
  /** 中止等待中的暂停点，例如 turn 被取消时。返回是否确有被中止的暂停点。 */
  abortPausePoint(sessionId: string, reason: unknown): boolean;
}
//#endregion
//#region src/index.d.ts
declare module '@deepseek-ai/cordis' {
  interface Events {
    'agent/pre-step'(this: never, payload: PreStepPayload, next: () => Promise<PreStepDecision>): Promise<PreStepDecision>;
    'agent/status'(this: never, payload: AgentStatusPayload): void;
  }
}
declare const name = "pause-ru";
/** 本插件需要的主机服务。connection 是 host 与浏览器共享的 RPC 载体，agents 用来把插话 steer 进当前 turn。 */
declare const inject: string[];
interface Config {
  defaultEnabled?: boolean;
}
declare const Config: z<Config>;
interface PreStepPayload {
  agent: AgentFace & {
    id: string;
  };
  turn: number;
  step: number;
  signal: AbortSignal;
  messages: UserMessage[];
}
type PreStepDecision = {
  kind: 'reject';
} | {
  kind: 'enter';
  messages: UserMessage[];
  startsRequestSeries?: true;
};
/** agent 的插话入口：steer 在最近一步认领，空闲时自己开新 turn。inbox 用来判断插话是否还在等认领。 */
interface AgentFace {
  /** 生命周期状态，强制继续只在空闲时允许。 */
  readonly status?: 'idle' | 'running';
  steer(message: UserMessage): void;
  /** 排到下一轮并唤醒 driver，强制继续用它把空的运行时上下文唤醒消息送进去。 */
  followup(message: UserMessage): void;
  readonly inbox: {
    readonly nextStep: readonly UserMessage[];
    readonly nextTurn: readonly UserMessage[];
  };
}
/** agent/status 的载荷，带的 agent 可直接 steer。 */
interface AgentStatusPayload {
  agent: AgentFace & {
    id: string;
  };
  status: 'idle' | 'running';
}
declare function apply(ctx: Context, config?: Config): void;
//#endregion
export { Config, DEFAULT_ENABLED, type PausePoint, PauseRegistry, type PauseSessionState, apply, createContinueMessage, initialSessionState, inject, name, shouldPause, textToMessage };