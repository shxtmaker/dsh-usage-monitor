import { hourKeyOf } from "./storage.js";

// 已报告样本归属于首次报告的小时；最终样本替换同一会话的同一步骤。
// 返回值：本次调用是否真的改变了小时桶（true = 有替换/扣减/增加，需要落盘）。
//   相同已标识会话、轮次、步骤，且供应商、归属小时与 token 总量都没变 → false（无效保存）。
//   无效输入（token 不是有限数、已标识步骤的样本未变化）同样不修改桶 → false。
//   未标识事件（turn/step 缺失）维持原有「每次都累加」规则，不做猜测去重。
export function createUsageRecorder(buckets) {
  const sessions = new WeakMap();
  return (session, supplier, usage, turn, step, date = new Date()) => {
    const values = [usage.inputTokens ?? usage.uncachedInputTokens, usage.outputTokens,
      usage.cacheReadTokens, usage.cacheWriteTokens];
    const tokens = values.reduce((sum, value) => {
      const n = Number(value);
      return sum + (Number.isFinite(n) && n > 0 ? n : 0);
    }, 0);
    if (!Number.isFinite(tokens)) return false;
    const hasSession = session !== null && (typeof session === "object" || typeof session === "function");
    let state = hasSession ? sessions.get(session) : null;
    if (!state || state.turn !== turn) {
      state = { turn, steps: new Map() };
      if (hasSession) sessions.set(session, state);
    }
    const identifiable = turn !== null && step !== null;
    const previous = identifiable ? state.steps.get(step) : null;
    const hour = previous?.hour ?? hourKeyOf(date);
    // 同一 (session, turn, step) 的样本未变（供应商、归属小时、总量都相同）⇒ 不碰桶。
    // 未标识事件没有 previous，永远不会走到这里。
    if (identifiable && previous && previous.supplier === supplier
      && previous.hour === hour && previous.tokens === tokens) {
      return false;
    }
    const hours = buckets[supplier] ??= {};
    let changed = false;
    if (previous) {
      const prior = buckets[previous.supplier];
      if (prior && (prior[hour] || 0) !== 0) {
        // 只有真的对非零桶做了替换/扣减才算变更（0 ⇒ 0 的扣减不改动数据）
        const next = Math.max(0, (prior[hour] || 0) - previous.tokens);
        if (next !== prior[hour]) { prior[hour] = next; changed = true; }
        if (!prior[hour]) delete prior[hour];
      }
    }
    if (tokens > 0) { hours[hour] = (hours[hour] || 0) + tokens; changed = true; }
    else if (hours[hour] === 0) delete hours[hour];
    if (identifiable) state.steps.set(step, { supplier, hour, tokens });
    return changed;
  };
}
