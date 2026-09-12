// lib/scan-coordinator.js — harness 扫描协调器（宿主半，无宿主依赖，便于单测）
//
// 职责边界（B1/B2）：
//   - 版本门禁：每次「来源变化」增加目标版本，旧候选立即失效；提交前必须再看一次版本。
//   - 单实例并发：同一时刻只跑一次扫描；常规周期复用进行中的扫描，不因定时到达让有效结果过期。
//   - 手动重扫：等待「至少自己那一版」的新扫描结果；30s 内拿不到就返回失败并提示稍后重试，
//     绝不把点击前的旧扫描包装成成功；后台扫描继续跑。
//   - 设置写入串行队列（B2）：本插件发起的所有 settings.update 走同一队列，任务执行时读最新配置。
//   - 生命周期：dispose() 后不再启动扫描、不再提交候选，并立刻释放所有等待者。
//
// 纯逻辑：不 import 宿主 API；scan()/commit() 由 index.js 注入。

/** 手动重扫的等待上限：到点返回失败并提示稍后重试。 */
const MANUAL_TIMEOUT_MS = 30_000;
/** 失败后的自动重试延迟：不依赖宿主的 30s 周期也能自愈（ref 定时器，进程不提前退出）。 */
const RETRY_AFTER_FAILURE_MS = 5_000;

/** 合并自动填入产生的 settings.watch 事件：避免自身写入触发无限重扫。 */
export function createSettingsWriteTracker() {
  let pending = 0;
  return {
    /** 包住一次插件侧写入：期间产生的 watch 事件视为自身变化。 */
    async run(fn) {
      pending++;
      try {
        return await fn();
      } finally {
        pending--;
      }
    },
    /** 收到 watch 事件时调用：true 表示这是本插件自己写入引起的。 */
    consumeSelfWrite() {
      if (pending <= 0) return false;
      pending--;
      return true;
    },
    get pending() { return pending; },
  };
}

export function createScanCoordinator({
  scan,
  commit,
  onError,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  manualTimeoutMs = MANUAL_TIMEOUT_MS,
  retryAfterFailureMs = RETRY_AFTER_FAILURE_MS,
  selfWrites = createSettingsWriteTracker(),
  logger,
} = {}) {
  if (typeof scan !== "function" || typeof commit !== "function") {
    throw new TypeError("createScanCoordinator 需要 scan() 与 commit() 注入");
  }
  let requested = 1;   // 目标版本：期望被扫描并提交的来源版本
  let completed = 0;   // 完成版本：最近一次成功扫描覆盖的版本
  let running = null;  // { target, promise }
  let lastScan = null; // 最近一次成功扫描的原始结果（扫描失败时保留旧快照）
  let disposed = false;
  let chain = Promise.resolve(); // 设置写入串行队列
  let waiters = [];    // [{ target, resolve, timer }]
  let retryTimer = null; // 失败后的自动重试

  /**
   * 目标版本前进（来源变化 / 手动重扫）。必须保证新目标严格大于 completed：
   * 否则「等待至少该版本的新扫描」会被一次已经完成的扫描直接满足 —— 手动重扫就会返回
   * 点击前的结果（真实缺陷）。dispose 只往前推 requested，不走这里。
   */
  const bump = () => { requested = Math.max(requested, completed) + 1; return requested; };

  const dropWaiters = (result) => {
    const pending = waiters;
    waiters = [];
    for (const waiter of pending) {
      if (waiter.finish) waiter.finish(result);
      else waiter.resolve(result);
    }
  };

  /** 成功提交后推进完成版本：释放所有已被覆盖（target ≤ completed）的等待者。 */
  function settle() {
    const remaining = [];
    for (const waiter of waiters) {
      if (completed >= waiter.target) {
        if (waiter.finish) waiter.finish({ ok: true, revision: completed, reason: waiter.reason });
        else waiter.resolve({ ok: true, revision: completed, reason: waiter.reason });
      } else {
        remaining.push(waiter);
      }
    }
    waiters = remaining;
  }

  async function perform() {
    const revision = requested;
    const detected = await scan({ revision });
    if (disposed) return { revision, stale: true };
    // 提交前最后一道校验：与 commit 之间不得插入 await（isCurrent 是同步断言）
    const isCurrent = () => !disposed && requested === revision;
    await commit({ revision, detected, isCurrent });
    return { revision, stale: false };
  }

  function launch(target) {
    const promise = (async () => {
      let outcome;
      let succeeded = false;
      try {
        outcome = await perform();
        if (disposed) return outcome;
        succeeded = true;
        if (!outcome.stale && outcome.revision === requested) {
          completed = outcome.revision;
          settle();
        }
        return outcome;
      } catch (error) {
        // 扫描失败：保留最后成功快照，只记录本轮错误；completed 不推进。
        try { onError?.(error, { requested, completed }); } catch { /* 记录失败不阻断协调器 */ }
        logger?.warn?.("[dsh-token-quota] 扫描失败: %s", error?.message || error);
        return { revision: requested, error };
      } finally {
        if (running?.target === target) running = null;
        // 追赶只在「本轮确实跑完（成功/候选过期）」时进行：扫描持续失败时立刻重排会在同一个
        // 同步批次里无限自旋（真实缺陷：宿主服务不可用时插件卡死主线程），失败改由退避重试兜底。
        if (succeeded && !disposed && !running && requested > completed) launch(requested);
        else if (!succeeded) scheduleRetry();
      }
    })();
    running = { target, promise };
    return promise;
  }

  /** 失败退避重试：保持 completed < requested 时的最终收敛，不依赖宿主周期。 */
  function scheduleRetry() {
    if (disposed || retryTimer) return;
    retryTimer = setTimer(() => {
      retryTimer = null;
      if (disposed || completed >= requested) return;
      launch(requested);
    }, retryAfterFailureMs);
    retryTimer?.unref?.();
  }

  /** 启动扫描（已有在跑的复用），返回覆盖当前目标版本的 Promise。 */
  function ensure() {
    if (disposed) return Promise.resolve({ revision: requested, disposed: true });
    if (running) return running.promise;
    return launch(requested);
  }

  return {
    /**
     * 请求扫描。
     * @param reason        'startup'|'periodic'|'routes'|'credentials'|'settings'|'manual'
     * @param requireFresh  true = 必须等待覆盖「自己这一版」的新扫描（手动重扫、来源变化）
     */
    request({ reason = "periodic", requireFresh = false } = {}) {
      if (disposed) return Promise.resolve({ ok: false, disposed: true, revision: requested });
      const target = requireFresh ? bump() : requested;
      const started = ensure();
      if (!requireFresh) return started;
      // 先建等待者再等扫描结束：等待者入表的时点可能晚于 commit（同一微任务队列里扫描已经
      // 完成），若只在入表后判定「completed 是否已覆盖 target」就会永远等不到（真实缺陷：
      // 手动重扫 30s 超时）。因此入表时先同步判定一次，settle() 同时负责已经入表的情形。
      return new Promise((resolve) => {
        const waiter = { target, reason, resolve, timer: null };
        const finish = (settled) => {
          if (waiter.timer) { clearTimer(waiter.timer); waiter.timer = null; }
          resolve(settled);
        };
        waiter.finish = finish;
        waiters.push(waiter);
        waiter.timer = setTimer(() => {
          waiters = waiters.filter((w) => w !== waiter);
          waiter.timer = null;
          if (disposed) { resolve({ ok: false, disposed: true, revision: requested }); return; }
          if (completed >= target) { resolve({ ok: true, revision: completed, reason }); return; }
          resolve({ ok: false, revision: requested, reason, error: "扫描尚未完成，请稍后重试" });
        }, manualTimeoutMs);
        waiter.timer?.unref?.();
        if (disposed) { finish({ ok: false, disposed: true, revision: requested }); return; }
        if (completed >= target) { finish({ ok: true, revision: completed, reason }); return; }
      });
    },

    /** 来源变化（路由/凭据/相关配置）：版本 +1 使旧候选失效，并合并启动后续扫描。 */
    noteSourceChange(reason = "settings") {
      if (disposed) return Promise.resolve({ ok: false, disposed: true, revision: requested });
      bump();
      return ensure().then(() => ({ ok: true, revision: completed, reason }));
    },

    /** 取消等待并阻止后续扫描与提交。 */
    dispose() {
      disposed = true;
      if (retryTimer) { clearTimer(retryTimer); retryTimer = null; }
      bump();
      dropWaiters({ ok: false, disposed: true, revision: requested });
    },

    /** 串行设置写入（B2）：任务执行时才读取最新配置；生命周期结束前不再执行。 */
    enqueueWrite(task) {
      if (disposed) return Promise.resolve({ ok: false, disposed: true });
      const next = chain.then(async () => {
        if (disposed) return { ok: false, disposed: true };
        return selfWrites.run(task);
      });
      chain = next.catch(() => {});
      return next;
    },

    /** settings.watch 到达：返回 true 表示这是本插件自身写入引起的。 */
    noteSettingsChange() {
      return selfWrites.consumeSelfWrite();
    },

    // ---- 状态展示与测试观察 ----
    get revision() { return { requested, completed }; },
    get lastScan() { return lastScan; },
    recordScanResult(detected, revision) { lastScan = { revision, detected }; },
    get disposing() { return disposed; },
    get waiting() { return waiters.length; },
  };
}

export const MANUAL_SCAN_TIMEOUT_MS = MANUAL_TIMEOUT_MS;
