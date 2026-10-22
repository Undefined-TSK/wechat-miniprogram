/**
 * 判题服务 HTTP 客户端（小程序侧）
 *
 * 分层说明：
 *   小程序 → 云函数（中转，注入鉴权 token）→ 判题服务
 *
 * **前端不持自建服务 token**。token 只存在于云函数环境变量里，
 * 前端拿到的只是云函数返回体。这是项目纪律第 6 条「密钥绝不出现在前端」的落点。
 *
 * 因此本文件只做三件事：组装请求、剥掉不该给页面看的东西、把错误归一化。
 */

import {
  isRetryable,
  VERDICT_TEXT,
  type JudgeErrorBody,
  type JudgeErrorCode,
  type JudgeRequest,
  type JudgeResponse,
  type JudgeVerdict,
  type ObjectiveJudgeRequest,
} from './judge-contract';

export interface JudgeClientResult {
  ok: boolean;
  response?: JudgeResponse;
  error?: { code: JudgeErrorCode; message: string; retryAfterMs?: number };
}

/**
 * 判题服务端点。
 *
 * ⚠️ 生产必须走云函数中转：这里应当是云函数的 name，而不是判题服务的域名。
 *    直接把 judge-service 域名写进前端 = 把内部服务暴露给全网，
 *    而且前端无法安全持有鉴权 token。
 */
const JUDGE_FUNCTION_NAME = 'judgeSubmit';

/** 判题失败时的兜底文案：用户看懂的 + 我们能排查的 */
const FALLBACK_ERROR: Record<JudgeErrorCode, string> = {
  unauthorized: '判题服务鉴权失败，请联系客服',
  forbidden: '无权提交本题',
  'rate-limited': '提交太频繁了，休息一下再试',
  'payload-too-large': '代码太长了，精简一下再提交',
  'unsupported-language': '暂不支持该语言',
  'question-not-found': '题目不存在或未配置判题',
  'session-expired': '本场次已结束，无法再提交',
  busy: '判题队列繁忙，请稍后重试',
  internal: '判题服务暂时不可用，请稍后重试',
};

function normalizeError(raw: unknown): { code: JudgeErrorCode; message: string; retryAfterMs?: number } {
  // 云函数返回结构：{ error: { code, message, retryAfterMs } }
  const body = raw as JudgeErrorBody | undefined;
  if (body && body.error && body.error.code) {
    return {
      code: body.error.code,
      message: body.error.message || FALLBACK_ERROR[body.error.code] || '判题失败',
      retryAfterMs: body.error.retryAfterMs,
    };
  }
  const err = raw as { errMsg?: string; message?: string } | undefined;
  return {
    code: 'internal',
    message: (err && (err.message || err.errMsg)) || '判题失败，请重试',
  };
}

/**
 * 剥掉服务端内部字段。
 *
 * 契约里定义了 systemNote（运维提示），它不应该出现在客户端。
 * 这里做一次显式裁剪而不是靠服务端自觉——两边都做，才不会有一边改漏。
 */
function stripInternal(res: JudgeResponse): JudgeResponse {
  const out: JudgeResponse = { ...res };
  delete (out as Record<string, unknown>).systemNote;
  return out;
}

export async function submitToJudge(req: JudgeRequest): Promise<JudgeClientResult> {
  try {
    const callRes = await wx.cloud.callFunction({
      name: JUDGE_FUNCTION_NAME,
      data: { payload: req },
    });

    const result = (callRes && (callRes as { result?: unknown }).result) as
      | JudgeClientResult['response']
      | JudgeErrorBody
      | undefined;

    if (!result) {
      return { ok: false, error: { code: 'internal', message: '判题服务无返回' } };
    }

    if ((result as JudgeErrorBody).error) {
      return { ok: false, error: normalizeError(result) };
    }

    return { ok: true, response: stripInternal(result as JudgeResponse) };
  } catch (err) {
    // 网络异常、云函数超时都走这里
    return { ok: false, error: normalizeError(err) };
  }
}

/** 该错误是否值得给「重试」按钮 */
export function canRetryError(code: JudgeErrorCode): boolean {
  return code === 'busy' || code === 'internal' || code === 'rate-limited';
}

/**
 * 客观题服务端判分（Boss 关 / 挑战关的选择、填空、程序输出题）。
 *
 * 走的是**同一个云函数**（judgeSubmit），由云函数按请求体形状分流：
 *   有 code 字段 → 沙箱判题链路
 *   有 answer 字段 → 客观题判分链路
 *
 * 为什么不另开一个云函数：
 *   云函数的冷启动、鉴权注入、错误归一化这三件事两边完全一样，
 *   开两个只会让「鉴权逻辑要改两处」这种漂移风险翻倍。
 *   分流判据放在请求体形状上，比放一个「mode」字段更难写错（忘了传 mode 会直接报缺字段）。
 */
export async function submitObjectiveToJudge(
  req: ObjectiveJudgeRequest
): Promise<JudgeClientResult & { result?: import('../engine/types').JudgeResult }> {
  try {
    const callRes = await wx.cloud.callFunction({
      name: JUDGE_FUNCTION_NAME,
      data: { payload: req },
    });

    const result = (callRes && (callRes as { result?: unknown }).result) as
      | { ok?: boolean; result?: import('../engine/types').JudgeResult }
      | JudgeErrorBody
      | undefined;

    if (!result) {
      return { ok: false, error: { code: 'internal', message: '判题服务无返回' } };
    }

    if ((result as JudgeErrorBody).error) {
      return { ok: false, error: normalizeError(result) };
    }

    const okBody = result as { ok?: boolean; result?: import('../engine/types').JudgeResult };
    if (!okBody.result) {
      return { ok: false, error: { code: 'internal', message: '判分结果为空' } };
    }
    return { ok: true, result: okBody.result };
  } catch (err) {
    return { ok: false, error: normalizeError(err) };
  }
}

/** 判题结论是否需要重试（复导出，方便页面从一个入口取） */
export function verdictRetryable(v: JudgeVerdict): boolean {
  return isRetryable(v);
}

export { VERDICT_TEXT };
