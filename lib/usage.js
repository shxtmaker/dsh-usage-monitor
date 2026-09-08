import { hourKeyOf } from "./storage.js";

// 已报告样本归属于首次报告的小时；最终样本替换同一会话的同一步骤。
export function createUsageRecorder(buckets) {
  const sessions = new WeakMap();
  return (session, supplier, usage, turn, step, date = new Date()) => {
    const values = [usage.inputTokens ?? usage.uncachedInputTokens, usage.outputTokens,
      usage.cacheReadTokens, usage.cacheWriteTokens];
    const tokens = values.reduce((sum, value) => {
      const n = Number(value);
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
    if (!Number.isFinite(tokens)) return;
    const hasSession = session !== null && (typeof session === "object" || typeof session === "function");
    let state = hasSession ? sessions.get(session) : null;
    if (!state || state.turn !== turn) {
      state = { turn, steps: new Map() };
      if (hasSession) sessions.set(session, state);
    }
    const identifiable = turn !== null && step !== null;
    const previous = identifiable ? state.steps.get(step) : null;
    const hour = previous?.hour ?? hourKeyOf(date);
    if (previous) {
      const hours = buckets[previous.supplier];
      if (hours) {
        hours[hour] = Math.max(0, (hours[hour] || 0) - previous.tokens);
        if (!hours[hour]) delete hours[hour];
      }
    }
    const hours = buckets[supplier] ??= {};
    hours[hour] = (hours[hour] || 0) + tokens;
    if (!hours[hour]) delete hours[hour];
    if (identifiable) state.steps.set(step, { supplier, hour, tokens });
  };
}
