(function () {
  const _fetch = window.fetch.bind(window);

  async function api(method, url, body) {
    const r = await _fetch(url, {
      method,
      headers: body ? { 'content-type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      credentials: 'same-origin'
    });
    if (r.status === 401) { location.href = '/login'; throw new Error('Signed out'); }
    if (!r.ok) {
      let msg = 'HTTP ' + r.status;
      try { msg = (await r.json()).error || msg; } catch {}
      throw new Error(msg);
    }
    return r.json();
  }

  const mePromise = api('GET', '/api/me').catch(() => null);
  const isAdminRole = role => role === 'admin' || role === 'owner';
  window.ME_PROMISE = mePromise; // let page scripts (e.g. index.html diagnostics) check role

  /* server-backed replacement for the artifact storage API */
  window.storage = {
    async get(key, shared = false) {
      if (key === 'agentName' && !shared) {
        const me = await mePromise;
        if (me) return { key, value: me.name, shared: false };
      }
      const d = await api('GET', `/api/kv/${encodeURIComponent(key)}?shared=${!!shared}`);
      return { key, value: d.value, shared: !!shared };
    },
    async set(key, value, shared = false) {
      if (key === 'agentName' && !shared) return { key, value, shared: false }; // comes from login
      await api('PUT', `/api/kv/${encodeURIComponent(key)}`,
                { value: String(value), shared: !!shared });
      return { key, value, shared: !!shared };
    },
    async delete(key, shared = false) {
      await api('DELETE', `/api/kv/${encodeURIComponent(key)}?shared=${!!shared}`);
      return { key, deleted: true, shared: !!shared };
    },
    async list(prefix = '', shared = false) {
      const d = await api('GET',
        `/api/kv?prefix=${encodeURIComponent(prefix)}&shared=${!!shared}`);
      return { keys: d.keys, prefix, shared: !!shared };
    }
  };

  /* fire-and-forget activity log entry — used for the agent history dashboard
     and, via the optional store param, the store/agent dashboards */
  window.logActivity = function (action, detail, store) {
    _fetch('/api/activity', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        action, detail: String(detail == null ? '' : detail).slice(0, 300),
        store: store == null ? '' : String(store).slice(0, 120)
      }),
      credentials: 'same-origin'
    }).catch(() => {});
  };

  /* route Claude calls through the server */
  window.fetch = function (input, init) {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('api.anthropic.com')) {
      return _fetch('/api/generate', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: (init && init.body) || '{}',
        credentials: 'same-origin'
      });
    }
    return _fetch(input, init);
  };

  /* session UI: lock the agent field, add sign-out, gate policy editing */
  document.addEventListener('DOMContentLoaded', async () => {
    const me = await mePromise;
    if (!me) return;

    const nameEl = document.getElementById('agentName');
    if (nameEl) { nameEl.value = me.name; nameEl.readOnly = true; nameEl.title = '@' + me.username + ' (' + me.role + ')'; }

    const bar = document.querySelector('.header-right');
    if (bar) {
      const wrap = document.createElement('span');
      wrap.className = 'row';
      wrap.style.gap = '8px';
      wrap.innerHTML =
        (isAdminRole(me.role) ? '<a href="/admin" class="btn secondary sm">Admin</a>' : '') +
        '<button class="btn secondary sm" id="signOutBtn">Sign out</button>';
      bar.appendChild(wrap);
      document.getElementById('signOutBtn').onclick = async () => {
        await api('POST', '/api/logout'); location.href = '/login';
      };
    }

    // Policy editing is admin/owner. Agents get a read-only view of
    // store policies.
    if (!isAdminRole(me.role)) {
      ['policyText', 'newStoreName', 'renameInput'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.readOnly = true; el.disabled = true; }
      });
      ['addStoreBtn', 'renameBtn', 'deleteBtn'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.disabled = true;
      });
      const n = document.getElementById('policyNotice');
      if (n) {
        n.className = 'noticeBox warn';
        n.innerHTML = '<strong>Read-only</strong>Policies are maintained by admins. ' +
                      'Contact one if something needs updating.';
      }
    }
    // "Reset to Defaults" (Diagnostics tab) rewrites shared policy data — owner-only.
    if (me.role !== 'owner') {
      const rb = document.getElementById('resetBtn');
      if (rb) rb.disabled = true;
    }
  });
})();
