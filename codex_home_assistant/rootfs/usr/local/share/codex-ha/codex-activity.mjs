// Activity observation is independent of transport lifetime and restartability.
// The caller must separately establish admission and state restoration before stop.
const GAUGES = ['app.requests.in_flight', 'app.requests.queued',
  'app.server_requests.pending', 'core.turns.active'];

async function pages(client, method, params = {}) {
  const rows = [], seen = new Set();
  let cursor = null;
  for (let page = 0; page < 100; page++) {
    const result = await client.call(method, { ...params, limit: 100, cursor });
    if (!result || !Array.isArray(result.data)) throw new Error('malformed_page');
    rows.push(...result.data);
    const next = result.nextCursor;
    if (next === undefined || next === null) return rows;
    if (typeof next !== 'string' || !next || seen.has(next)) throw new Error('invalid_cursor');
    seen.add(next);
    cursor = next;
  }
  throw new Error('page_limit');
}

export async function observeActivity(client, expectedPid, { allowLazyGauges = false } = {}) {
  try {
    const diag = await client.call('server/diagnostics', {});
    if (!Number.isSafeInteger(diag?.process?.id) || diag.process.id <= 0 ||
        diag.process.id !== expectedPid) throw new Error('identity_mismatch');
    if (!Array.isArray(diag.gauges)) throw new Error('missing_gauges');
    const values = new Map();
    for (const gauge of diag.gauges) {
      if (!GAUGES.includes(gauge?.name)) continue;
      if (values.has(gauge.name) || !Number.isSafeInteger(gauge.value) || gauge.value < 0)
        throw new Error('malformed_gauge');
      values.set(gauge.name, gauge.value);
    }
    for (const name of GAUGES) {
      if (!values.has(name)) {
        if (!allowLazyGauges || name === GAUGES[0]) throw new Error('missing_gauge');
        values.set(name, 0);
      }
    }
    if (values.get(GAUGES[0]) < 1) throw new Error('invalid_probe_baseline');
    const counts = { requests: values.get(GAUGES[0]) - 1, queued: values.get(GAUGES[1]),
      serverRequests: values.get(GAUGES[2]), turns: values.get(GAUGES[3]),
      loaded: 0, activeThreads: 0, background: 0 };
    const threads = await pages(client, 'thread/loaded/list');
    const unique = new Set();
    for (const id of threads) {
      if (typeof id !== 'string' || !id || unique.has(id)) throw new Error('malformed_thread_list');
      unique.add(id);
      const result = await client.call('thread/read', { threadId: id, includeTurns: false });
      if (result?.thread?.id !== id) throw new Error('thread_identity_mismatch');
      const status = result.thread.status?.type;
      if (!['idle', 'notLoaded', 'active'].includes(status)) throw new Error('unknown_thread_status');
      if (status === 'active') counts.activeThreads++;
      if (status !== 'notLoaded') {
        const terminals = await pages(client, 'thread/backgroundTerminals/list', { threadId: id });
        counts.background += terminals.length;
      }
    }
    counts.loaded = unique.size;
    const busy = Object.entries(counts).some(([name, n]) => name !== 'loaded' && n > 0);
    return { activity: busy ? 'busy' : 'idle', complete: true, pid: expectedPid, counts };
  } catch (error) {
    // RPC errors can contain user-controlled data; never include their text.
    const allowed = ['identity_mismatch','missing_gauges','malformed_gauge','missing_gauge','invalid_probe_baseline','malformed_thread_list','thread_identity_mismatch','unknown_thread_status','malformed_page','invalid_cursor','page_limit'];
    return { activity: 'unknown', complete: false, reason: allowed.includes(error.message) ? error.message : 'activity_inspection_failed' };
  }
}
