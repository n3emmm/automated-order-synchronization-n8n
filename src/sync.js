// Pure transition function. Exactly one state item travels around the n8n loop.
function transition(s, response, now = Date.now()) {
  const headers = ['order_id', 'status', 'total_minor', 'currency', 'updated_at'];
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const stop = reason => {
    s.fatal = reason;
    s.op = 'done';
    return s;
  };
  const next = op => { s.op = op; s.attempt = 1; };
  const error = (id, reason) => s.errors.push({ order_id: id, reason });
  const selectBatch = () => {
    s.batch = s.queue.splice(0, s.single ? 1 : 40);
    next(s.batch.length ? 'write' : 'done');
    if (s.single && s.batch.length) s.attempt = s.batch[0].start || 1;
  };
  const code = Number(response.statusCode || 0);
  const retryable = !code || [408, 425, 429].includes(code) || (code >= 500 && code <= 599);
  s.delay = 0;
  if (code === 401 || code === 403) return stop('authentication_' + code);
  if (code < 200 || code >= 300) {
    s.events.push({ operation: s.op, status: code, attempt: s.attempt });
    if (retryable) {
      const value = String(response.headers?.['retry-after'] ?? response.headers?.['Retry-After'] ?? '').trim();
      const seconds = /^\d+$/.test(value) ? Number(value) : (Date.parse(value) - now) / 1000;
      s.delay = Math.max(2 ** (s.attempt - 1), Number.isFinite(seconds) ? Math.ceil(seconds) : 0);
      if (s.op === 'write') {
        s.writeAttempt = s.attempt;
        next('verify'); // Read even after the third write, which might have committed.
      } else if (s.attempt < 3) s.attempt++;
      else return stop(s.op + '_retry_exhausted');
      return s;
    }
    if (s.op !== 'write' || code !== 400) return stop(s.op + '_http_' + code);
    if (s.batch.length > 1 && s.attempt < 3) {
      s.single = true;
      for (const entry of s.batch) entry.start = s.attempt + 1;
      s.queue.unshift(...s.batch);
    } else for (const entry of s.batch) error(entry.values[0], 'write_rejected');
    selectBatch();
    return s;
  }
  const body = response.body;
  if (s.op === 'page') {
    if (!Array.isArray(body?.orders) || !Object.hasOwn(body,'next_cursor')) return stop('invalid_page');
    for (const order of body.orders) {
      const id = order?.order_id;
      const ts = order?.updated_at;
      if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id) ||
          !['paid','pending','cancelled','shipped'].includes(order.status) ||
          !Number.isSafeInteger(order.total_minor) || order.total_minor < 0 ||
          !/^[A-Z]{3}$/.test(String(order.currency)) || typeof order.currency !== 'string' ||
          typeof ts !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(ts) ||
          !Number.isFinite(Date.parse(ts)) || new Date(ts).toISOString() !== ts.slice(0,-1)+'.000Z') {
        error(typeof id === 'string' ? id.slice(0,80) : null,'invalid_order');
        continue;
      }
      const key = ':' + id;
      const row = [id,order.status,String(order.total_minor),order.currency,ts];
      if (Object.hasOwn(s.orders,key)) {
        if (equal(s.orders[key],row)) s.duplicates++;
        else if (s.orders[key] !== null) { error(id,'conflicting_source'); s.orders[key] = null; }
      } else s.orders[key] = row;
    }
    s.pages++;
    if (body.next_cursor === null) { next('index'); return s; }
    if (typeof body.next_cursor !== 'string' || !body.next_cursor || s.seen.includes(body.next_cursor))
      return stop('invalid_or_repeated_cursor');
    if (s.pages >= s.maxPages) return stop('page_limit');
    s.cursor = body.next_cursor;
    s.seen.push(s.cursor);
    next('page');
    return s;
  }
  if (s.op === 'index' || s.op === 'verify') {
    const rows = body?.values;
    if (!Array.isArray(rows) || !equal(rows[0],headers)) return stop('invalid_sheet_header');
    const index = new Map();
    for (let i=1; i<rows.length; i++) {
      const row = rows[i];
      if (!Array.isArray(row)) return stop('invalid_sheet_row');
      if (!row.length) continue;
      if (!row[0] || index.has(row[0])) return stop('missing_or_duplicate_sheet_id');
      index.set(row[0], i+1);
    }
    if (s.op === 'verify') {
      const pending = [];
      for (const entry of s.batch) {
        const actual = rows[entry.row-1] || [];
        if (equal(actual,entry.values)) s.counts[entry.kind]++;
        else if (!equal(actual,entry.before)) return stop('writer_conflict');
        else pending.push(entry);
      }
      if (!pending.length) selectBatch();
      else if (s.writeAttempt >= 3) {
        for (const e of pending) error(e.values[0],'write_unconfirmed');
        selectBatch();
      } else { s.batch = pending; s.op = 'write'; s.attempt = s.writeAttempt + 1; }
      return s;
    }
    let end = rows.length;
    for (const values of Object.values(s.orders)) {
      if (!values) continue;
      const found = index.get(values[0]);
      const before = found ? rows[found-1] : [];
      if (equal(before,values)) s.counts.skipped++;
      else s.queue.push({row: found || ++end, values, before, kind: found ? 'updated' : 'added'});
    }
    delete s.orders;
    selectBatch();
    return s;
  }
  // A success response with an incomplete acknowledgement also needs reconciliation.
  if (body?.totalUpdatedRows !== s.batch.length) {
    s.writeAttempt = s.attempt;
    next('verify');
  } else {
    for (const entry of s.batch) s.counts[entry.kind]++;
    selectBatch();
  }
  return s;
}
