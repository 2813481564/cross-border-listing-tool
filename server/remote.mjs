/**
 * 本地采集端 -> 线上服务器的推送。
 *
 * 只传结构化数据（商品 + 草稿 + 媒体远程地址），服务器收到后自己写库并下载媒体。
 * 本地不直连线上数据库：数据库只由服务器持有，避免暴露端口和 schema 耦合。
 */
export async function pushRecord(record, config, { timeoutMs = 60000 } = {}) {
  const remote = config?.remote;
  if (!remote?.enabled) return { skipped: true, reason: '未启用远程推送' };
  if (!remote.baseUrl) return { skipped: true, reason: '未配置 remote.baseUrl' };

  const url = `${remote.baseUrl.replace(/\/+$/, '')}/api/ingest`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${remote.token ?? ''}`
      },
      body: JSON.stringify({ record }),
      signal: controller.signal
    });

    const text = await res.text();
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      payload = { ok: false, error: text.slice(0, 200) };
    }

    if (!res.ok || !payload.ok) {
      return { ok: false, error: payload.error || `HTTP ${res.status}` };
    }
    return { ok: true, offerId: payload.offerId };
  } catch (err) {
    return { ok: false, error: err.name === 'AbortError' ? '推送超时' : err.message };
  } finally {
    clearTimeout(timer);
  }
}

/** 推送失败的任务暂存，便于稍后重推 */
const pending = new Map();

export function rememberFailedPush(record, error) {
  pending.set(record.offerId, { record, error, at: new Date().toISOString() });
}

export function listFailedPushes() {
  return [...pending.values()];
}

export function clearFailedPush(offerId) {
  pending.delete(offerId);
}

export async function retryFailedPushes(config) {
  const results = [];
  for (const [offerId, item] of pending) {
    const result = await pushRecord(item.record, config);
    if (result.ok) {
      pending.delete(offerId);
      results.push({ offerId, ok: true });
    } else {
      results.push({ offerId, ok: false, error: result.error });
    }
  }
  return results;
}

export function pendingCount() {
  return pending.size;
}
