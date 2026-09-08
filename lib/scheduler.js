// 每个宿主实例拥有独立调度器；配置变更使旧请求结果失效。
const BACKOFF = [30_000, 60_000, 120_000, 240_000, 600_000];

export function createScheduler({ providers, getConfig, onRecord, now = Date.now }) {
  const slots = Object.fromEntries(Object.keys(providers).map((id) => [id, {
    last: null, lastSuccessAt: null, nextAt: 0, failures: 0,
    inFlight: null, configKey: null, revision: 0,
  }]));
  let disposed = false;
  function sync(id) {
    const slot = slots[id];
    const config = getConfig(id);
    const key = JSON.stringify(config);
    if (slot.configKey !== key) {
      slot.configKey = key;
      slot.revision++;
      slot.last = null;
      slot.lastSuccessAt = null;
      slot.nextAt = 0;
      slot.failures = 0;
    }
    return config;
  }
  function run(id, { force = false, interval = 60_000 } = {}) {
    const config = sync(id);
    const slot = slots[id];
    if (disposed || !config.enabled) return Promise.resolve(null);
    if (slot.inFlight) return slot.inFlight;
    if (!force && slot.nextAt > now()) return Promise.resolve(slot.last);
    const revision = slot.revision;
    slot.inFlight = Promise.resolve().then(() => providers[id].query(config)).catch((error) => ({
      state: "err", error: { code: error?.code || "network", message: error?.message || String(error) },
      entries: [], headline: { kind: "amt", amt: "—" },
    })).then((result) => {
      sync(id);
      if (disposed || revision !== slot.revision) return null;
      const time = now();
      const t = new Date(time).toLocaleTimeString();
      const ok = result.state !== "err" && result.state !== "off";
      if (ok) {
        slot.failures = 0;
        slot.lastSuccessAt = time;
        slot.nextAt = time + interval;
      } else {
        const delay = result.error?.code === "auth" ? 30 * 60_000
          : BACKOFF[Math.min(slot.failures, BACKOFF.length - 1)];
        slot.failures++;
        slot.nextAt = time + delay;
      }
      // 无新条目的失败保留上次数据；部分成功保留本次供应商返回的有效条目。
      slot.last = !ok && slot.last && !result.entries?.length
        ? { ...slot.last, state: result.state, error: result.error, fetchedAt: `${t}（失败）` }
        : { ...result, fetchedAt: t };
      onRecord({ t, supplier: id, ok, error: ok ? null : `${result.error?.code}: ${result.error?.message}`,
        summary: slot.last.headline?.amt ?? slot.last.headline?.pct ?? "—" });
      return slot.last;
    }).finally(() => { slot.inFlight = null; });
    return slot.inFlight;
  }
  return {
    slots, run,
    sync: () => Object.keys(providers).forEach(sync),
    tick(interval) { for (const id of Object.keys(providers)) run(id, { interval }); },
    dispose() { disposed = true; },
  };
}
