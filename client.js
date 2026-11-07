/**
 * @local/dsh-wrainrock-daemon — Client half.
 *
 * Renders the manual "重启" control in two independent places, so one hidden
 * slot can never hide the feature:
 *
 *   - `conversation.composer.dock`  a compact pill under the composer
 *   - `sidebar.footer.action`       a full row beside Settings
 *
 * The restart lifecycle deliberately lives OUTSIDE React (see
 * `createRestartFlow`): the dock control sits in a session-scoped slot that
 * collapses as soon as the transport drops, so a component cleanup must never
 * abort a restart already in flight. The controls only read the shared flow
 * state and call `activate()`.
 *
 * Defensive rules learned the hard way:
 *   - a failing POST does not end the flow: the response is usually lost
 *     because the server dies first, and the restart may well have happened;
 *   - the page reloads whenever it is provably stale (the server pid moved, or
 *     the server went away and came back) — the SPA's own reconnect can keep
 *     using a stale launch token, so a fresh page load is the reliable end
 *     state;
 *   - the whole control sits inside `SafeBoundary`: a crash renders a plain
 *     working button instead of blanking the slot entry;
 *   - every step reports to the Host (`/event`), so a failure can be diagnosed
 *     from the server side.
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-wrainrock-daemon',
  factory(require) {
    const React = require('react')
    const h = React.createElement

    const NS = 'dsh-wrainrock-daemon'
    const BASE = '/dsh-wrainrock-daemon'
    const zh = {
      restart: '重启',
      confirm: '确认重启？',
      busy: '重启中…',
      failed: '重启失败',
      timeout: '服务未恢复，请手动刷新',
      noeffect: '重启未生效',
      starting: '服务仍在启动，请稍后手动刷新',
      safe: '安全模式',
      hint: '重启 DeepSeek Harness',
      hintSafe: '重启 DeepSeek Harness（上次启动进入了安全模式）',
      unavailable: '无法读取服务状态',
      // Temporary crash recovery: one plugin is disabled for THIS boot only and
      // is re-enabled automatically once a run stays healthy.
      temporaryDisabled: '临时禁用',
      temporaryDisabledHint: '本次启动临时禁用了 {ids}（崩溃自动恢复）；服务稳定运行后会自动撤销',
      temporaryDisabledAria: '本次启动临时禁用了 {ids}',
      // Settings → Daemon: the service port and the disabled Cloudflare row.
      sectionLabel: 'Daemon',
      sectionIntro: 'DeepSeek Harness 服务的监听端口。修改「下次启动端口」只影响下一次启动，不会中断当前会话。',
      portCurrent: '当前端口',
      portNext: '下次启动端口',
      portSourceLive: '实际运行中',
      portSourceOverride: '来自下次启动覆盖',
      portSourceConfig: '来自配置',
      portPending: '重启后生效',
      portLoading: '读取中…',
      portUnavailable: '不可用',
      portInvalid: '请输入 1–65535 之间的整数端口',
      portSave: '保存',
      portSaveRestart: '保存并重启',
      portSaving: '保存中…',
      portRestarting: '保存并重启中…',
      portSaved: '已保存，下次启动生效',
      portSavedRestart: '已保存，服务即将重启；页面稍后需要刷新',
      portFailed: '保存失败',
      // Settings → Daemon: the stable sign-in entry (the launch cookie is bound
      // to host:port, so a port change invalidates the old cookie).
      entryTitle: '登录入口',
      entryIntro: '换端口后旧登录会失效；从这个入口打开会自动登录，建议收藏。',
      entryAddress: '入口地址',
      entryOpen: '打开 DeepSeek Harness',
      entryCopy: '复制登录链接',
      entryCopied: '已复制',
      entryCopyFailed: '复制失败，请手动选中下面的链接',
      entryHint: '端口变更后需重新从这个入口打开（登录 cookie 绑定 host:port）。',
      entryUnavailable: '入口信息不可用',
      cloudflareLabel: '转发至 Cloudflare 域名',
      cloudflareBadge: '实验性·开发中',
      cloudflareHint: '占位功能：把本地服务转发到一个 Cloudflare 域名，目前尚未开放，暂时无法开启。',
    }
    const en = {
      restart: 'Restart',
      confirm: 'Confirm restart?',
      busy: 'Restarting…',
      failed: 'Restart failed',
      timeout: 'Service did not come back — reload the page',
      noeffect: 'Restart had no effect',
      starting: 'Service is still starting — reload in a moment',
      safe: 'Safe mode',
      hint: 'Restart DeepSeek Harness',
      hintSafe: 'Restart DeepSeek Harness (the last boot entered safe mode)',
      unavailable: 'Service status unavailable',
      temporaryDisabled: 'Temp disabled',
      temporaryDisabledHint: 'This boot temporarily disabled {ids} (automatic crash recovery); it is re-enabled once the service stays healthy',
      temporaryDisabledAria: 'This boot temporarily disabled {ids}',
      sectionLabel: 'Daemon',
      sectionIntro: 'The listening port of the DeepSeek Harness service. Changing the next-start port only affects the next start; the current session is not interrupted.',
      portCurrent: 'Current port',
      portNext: 'Next-start port',
      portSourceLive: 'Serving now',
      portSourceOverride: 'From next-start override',
      portSourceConfig: 'From configuration',
      portPending: 'Takes effect after a restart',
      portLoading: 'Loading…',
      portUnavailable: 'Unavailable',
      portInvalid: 'Enter an integer port between 1 and 65535',
      portSave: 'Save',
      portSaveRestart: 'Save & restart',
      portSaving: 'Saving…',
      portRestarting: 'Saving and restarting…',
      portSaved: 'Saved — takes effect on the next start',
      portSavedRestart: 'Saved — the service is restarting; reload the page in a moment',
      portFailed: 'Save failed',
      entryTitle: 'Sign-in entry',
      entryIntro: 'Changing the port invalidates the old sign-in; open from this entry to sign in automatically, and bookmark it.',
      entryAddress: 'Entry address',
      entryOpen: 'Open DeepSeek Harness',
      entryCopy: 'Copy sign-in link',
      entryCopied: 'Copied',
      entryCopyFailed: 'Copy failed — select the link below manually',
      entryHint: 'After a port change, open from this entry again (the sign-in cookie is bound to host:port).',
      entryUnavailable: 'Entry information unavailable',
      cloudflareLabel: 'Forward to a Cloudflare domain',
      cloudflareBadge: 'Experimental · in development',
      cloudflareHint: 'Placeholder: forward this local service to a Cloudflare domain. Not available yet and cannot be enabled for now.',
    }

    const CSS = `
.dsa-btn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-secondary);font:inherit;
  font-size:12px;line-height:1;cursor:pointer;white-space:nowrap;
  transition:background .12s ease,color .12s ease}
.dsa-btn:hover:not([disabled]){background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}
.dsa-btn:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
.dsa-btn[disabled]{opacity:.65;cursor:default}
.dsa-btn.dsa-danger{border-color:var(--dsw-alias-state-error-primary);color:var(--dsw-alias-state-error-primary)}
.dsa-btn.dsa-warn{border-color:var(--dsw-alias-state-warn-primary);color:var(--dsw-alias-state-warn-primary)}
.dsa-dot{flex:none;width:6px;height:6px;border-radius:50%;background:var(--dsw-alias-state-warn-primary)}
.dsa-spin{animation:dsa-spin 1s linear infinite}
@keyframes dsa-spin{to{transform:rotate(360deg)}}
.dsa-row{box-sizing:border-box;border-radius:var(--dsw-radius-md,8px);min-height:36px;width:100%;
  color:var(--dsw-alias-label-primary);font:inherit;text-align:left;cursor:pointer;background:0 0;
  border:none;align-items:center;gap:8px;margin:0 2px;padding:7px 8px;line-height:22px;display:flex}
.dsa-row:hover{background:var(--dsw-alias-interactive-bg-hover)}
.dsa-row:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}
.dsa-row.dsa-rail{border-radius:var(--dsw-radius-md,8px);width:36px;height:36px;justify-content:center;margin:0;padding:0}
.dsa-row.dsa-warn{color:var(--dsw-alias-state-warn-primary)}
.dsa-rowLabel{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;min-width:0}
.dsa-badge{flex:none;display:inline-flex;align-items:center;height:16px;padding:0 6px;
  border:1px solid var(--dsw-alias-state-warn-primary);border-radius:999px;
  color:var(--dsw-alias-state-warn-primary);font-size:10px;line-height:1;white-space:nowrap}
/* Settings → Daemon. Card/fill tokens match the other settings sections. */
.dsa-sec{display:flex;flex-direction:column;gap:16px;padding:8px 0;
  color:var(--dsw-alias-label-primary);font-size:13px;line-height:22px}
.dsa-card{display:flex;flex-direction:column;gap:10px;box-sizing:border-box;padding:12px 16px;
  border:.5px solid var(--dsw-alias-settings-card-stroke,var(--dsw-alias-border-l2));
  border-radius:var(--dsw-radius-xl,12px);background:var(--dsw-alias-settings-card-fill,transparent)}
.dsa-field{display:flex;flex-direction:column;gap:6px}
.dsa-label{color:var(--dsw-alias-label-secondary);font-size:12px;line-height:18px}
.dsa-value{font-size:16px;font-weight:500;line-height:24px}
.dsa-hint{margin:0;color:var(--dsw-alias-label-tertiary);font-size:12px;line-height:18px}
.dsa-warnText{color:var(--dsw-alias-state-warn-primary)}
.dsa-okText{color:var(--dsw-alias-state-business-primary)}
.dsa-errText{color:var(--dsw-alias-state-error-primary)}
.dsa-inline{display:flex;flex-wrap:wrap;align-items:center;gap:8px}
.dsa-input{box-sizing:border-box;width:120px;height:32px;padding:0 10px;font:inherit;font-size:13px;
  border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-sm,6px);
  background:var(--dsw-alias-bg-layer-1);color:var(--dsw-alias-label-primary)}
.dsa-input:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid
  var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:1px}
/* Settings → Daemon: the sign-in entry stays readable AND selectable by hand. */
.dsa-url{font-family:var(--dsw-font-family-mono,ui-monospace,SFMono-Regular,Menlo,Consolas,monospace);
  font-size:12px;line-height:18px;word-break:break-all;user-select:text;
  color:var(--dsw-alias-label-secondary)}
.dsa-btn.dsa-primary{border-color:transparent;background:var(--dsw-alias-button-primary-fill);
  color:var(--dsw-alias-label-primary-foreground);font-weight:500}
.dsa-btn.dsa-primary:hover:not([disabled]){background:var(--dsw-alias-button-primary-hover);
  color:var(--dsw-alias-label-primary-foreground)}
/* The experimental Cloudflare row is a plain, non-interactive div. */
.dsa-row.dsa-disabled{cursor:default;opacity:.6}
.dsa-row.dsa-disabled:hover{background:0 0}
`

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    function postJson(path, body) {
      return fetch(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'x-dsh-wrainrock-daemon': '1', 'content-type': 'text/plain' },
        body,
        cache: 'no-store',
        // The page navigates immediately after the final report; keepalive lets
        // that report outlive the reload instead of being cancelled with it.
        keepalive: true,
      })
    }

    /** Best-effort lifecycle report; the Host appends it to state/client-events.jsonl. */
    function report(event, data) {
      try {
        const promise = postJson('/event', `${event} ${JSON.stringify(data ?? {})}`)
        if (promise && typeof promise.catch === 'function') promise.catch(() => {})
      } catch {
        /* reporting must never break the flow */
      }
    }

    async function readStatus() {
      const response = await fetch(`${BASE}/status?hb=1`, { cache: 'no-store' })
      if (!response.ok) throw new Error(`status ${response.status}`)
      return await response.json()
    }

    /**
     * Port snapshot for Settings → Daemon. `GET /port` is the primary route;
     * an older host half that lacks it still carries the same shape under
     * `status.port`, so fall back to that instead of failing. Returns null when
     * neither route answers — the section then renders the 不可用 state.
     */
    async function readPortSnapshot() {
      try {
        const response = await fetch(`${BASE}/port`, { cache: 'no-store' })
        if (response.ok) {
          const data = await response.json()
          if (data && typeof data === 'object' && data.ok !== false) return data
        }
      } catch {
        /* route missing, daemon down or a malformed body — try the status route */
      }
      try {
        const status = await readStatus()
        const port = status?.port
        if (port && typeof port === 'object') return { ok: true, ...port }
      } catch {
        /* both routes are unavailable; the caller renders 不可用 */
      }
      return null
    }

    /**
     * Sign-in entry for Settings → Daemon. `GET /url` answers with the plain UI
     * address, the authenticated link for this process and a stable `entry` that
     * re-issues the launch cookie. Returns null on a non-2xx answer, a malformed
     * body or a missing route — the section then renders 不可用 instead of
     * breaking the panel.
     */
    async function readEntryInfo() {
      try {
        const response = await fetch(`${BASE}/url`, { cache: 'no-store' })
        if (!response.ok) return null
        const data = await response.json()
        if (!data || typeof data !== 'object' || data.ok === false) return null
        return data
      } catch {
        return null
      }
    }

    /** Trimmed non-empty string from a route field; anything else reads as null. */
    function textOf(value) {
      if (typeof value !== 'string') return null
      const text = value.trim()
      return text === '' ? null : text
    }

    /** URL the 打开 button uses: the stable entry first, then the plain UI address. */
    function entryTarget(info) {
      return textOf(info?.entry) ?? textOf(info?.current)
    }

    /** URL 复制 uses: the authenticated link when the host has one, else the entry. */
    function copyTarget(info) {
      return textOf(info?.authenticated) ?? entryTarget(info)
    }

    /** Client-side range check (integer 1..65535); null means "not a valid port". */
    function parsePortInput(raw) {
      const text = typeof raw === 'number' ? String(raw) : String(raw ?? '').trim()
      if (!/^\d{1,5}$/.test(text)) return null
      const port = Number(text)
      return Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null
    }

    /** Locale key for the snapshot's `source`; unknown values read as "live". */
    function portSourceKey(source) {
      if (source === 'override') return 'portSourceOverride'
      if (source === 'config') return 'portSourceConfig'
      return 'portSourceLive'
    }

    /** Query string for the save request; `restart=1` asks the host to restart. */
    function portQuery(port, restart) {
      return `/port?port=${port}${restart ? '&restart=1' : ''}`
    }

    /**
     * Decide whether the page is provably stale after a restart request. This is
     * the one decision that must not regress: getting it wrong leaves the user
     * on a dead page, so it is a pure function exposed to the test seam.
     */
    function decideAfterPoll(state) {
      const { before, next, sawDown } = state
      const stale = (next !== undefined && before !== null && next?.process?.pid !== before)
        || (sawDown && next !== undefined)
      if (!stale) return 'wait'
      // /status answers as soon as this plugin mounts, but the route the shell
      // needs (`/api`) is registered only after `appReady`. Reloading inside that
      // window lands on a page that cannot connect — the reported "stuck" page.
      if (next !== undefined && next.ready === false) return 'wait-not-ready'
      return 'reload'
    }

    /** The restart lifecycle. `deps` is injectable so a test can drive it in Node. */
    function createRestartFlow(deps) {
      const {
        status = readStatus,
        post = (path) => postJson(path, ''),
        reload = () => window.location.reload(),
        wait = sleep,
        now = () => Date.now(),
        translate = (key) => key,
        report: reportEvent = report,
      } = deps ?? {}

      const flow = {
        phase: 'idle',
        note: null,
        lastStatus: null,
        running: false,
        elapsed: 0,
        listeners: new Set(),
        timer: null,
        pollTimer: null,
        elapsedTimer: null,
      }

      const emit = () => {
        for (const listener of Array.from(flow.listeners)) {
          try { listener() } catch { /* one bad listener must not break the flow */ }
        }
      }
      const set = (patch) => { Object.assign(flow, patch); emit() }
      const subscribe = (listener) => { flow.listeners.add(listener); return () => flow.listeners.delete(listener) }

      /** One shared status poller for both controls; React mount churn must not stop it. */
      function ensurePolling() {
        if (flow.pollTimer !== null) return
        const tick = () => { status().then((next) => { flow.lastStatus = next; emit() }).catch(() => {}) }
        tick()
        flow.pollTimer = setInterval(tick, 20000)
      }

      async function run() {
        if (flow.running) return
        flow.running = true
        const before = flow.lastStatus?.process?.pid ?? null
        set({ phase: 'busy', note: null })
        reportEvent('restart:click', { pid: before })

        try {
          const response = await post('/restart')
          reportEvent('restart:posted', { ok: response?.ok === true, status: response?.status })
        } catch (error) {
          // The server usually dies before the response lands; the restart may
          // still have happened, so keep watching instead of giving up.
          reportEvent('restart:post-failed', { message: String(error?.message ?? error) })
        }

        const startedAt = now()
        const deadline = startedAt + 120000
        flow.elapsed = 0
        if (flow.elapsedTimer) clearInterval(flow.elapsedTimer)
        flow.elapsedTimer = setInterval(() => {
          flow.elapsed = Math.round((now() - startedAt) / 1000)
          emit()
        }, 1000)
        let answered
        let sawDown = false
        let waitedForReady = false
        while (now() < deadline) {
          await wait(500)
          try {
            const next = await status()
            answered = next
            flow.lastStatus = next
            emit()
            const decision = decideAfterPoll({ before, next, sawDown })
            if (decision === 'reload') {
              reportEvent('restart:reload', { pid: next?.process?.pid ?? null, sawDown, readyAfterMs: now() - startedAt })
              if (flow.elapsedTimer) clearInterval(flow.elapsedTimer)
              reload()
              return
            }
            if (decision === 'wait-not-ready' && !waitedForReady) {
              waitedForReady = true
              reportEvent('restart:waiting-ready', { pid: next?.process?.pid ?? null })
            }
          } catch {
            if (!sawDown) reportEvent('restart:down', {})
            sawDown = true
          }
        }

        flow.running = false
        if (flow.elapsedTimer) { clearInterval(flow.elapsedTimer); flow.elapsedTimer = null }
        const ready = answered === undefined ? undefined : answered.ready !== false
        if (answered !== undefined && sawDown && ready) {
          reportEvent('restart:reload-after-timeout', {})
          reload()
          return
        }
        reportEvent('restart:timeout', { answered: answered !== undefined, ready })
        if (answered === undefined) set({ phase: 'error', note: translate('timeout') })
        else if (sawDown && !ready) set({ phase: 'error', note: translate('starting') })
        else set({ phase: 'error', note: translate('noeffect') })
      }

      /** Two-step confirmation, then the restart itself. */
      function activate() {
        if (flow.phase === 'busy') return
        if (flow.phase !== 'confirm') {
          set({ phase: 'confirm', note: null })
          if (flow.timer) clearTimeout(flow.timer)
          flow.timer = setTimeout(() => { if (flow.phase === 'confirm') set({ phase: 'idle' }) }, 6000)
          return
        }
        if (flow.timer) clearTimeout(flow.timer)
        flow.phase = 'busy'
        run()
      }

      return { flow, subscribe, ensurePolling, activate, run, decideAfterPoll }
    }

    /** One flow per page, shared by both controls. */
    let translate = (key) => zh[key] ?? key
    let FLOW = createRestartFlow({ translate })

    function useFlow(where) {
      const [, bump] = React.useState(0)
      React.useEffect(() => {
        // Page-liveness beacon: proves the control (and therefore the page)
        // really came back after a restart.
        try {
          const beacon = postJson('/mounted', where)
          if (beacon && typeof beacon.catch === 'function') beacon.catch(() => {})
        } catch { /* best effort */ }
        const unsubscribe = FLOW.subscribe(() => bump((n) => n + 1))
        FLOW.ensurePolling()
        return unsubscribe
      }, [])
      return FLOW.flow
    }

    /** Restart immediately, without any of the stateful UI (used by the crash fallback). */
    function fireRestart() {
      try {
        const promise = postJson('/restart', '')
        if (promise && typeof promise.catch === 'function') promise.catch(() => {})
      } catch {
        /* a fallback button must never throw */
      }
    }

    function RestartIcon(props) {
      return h('svg', {
        width: 13, height: 13, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor',
        strokeWidth: 2.2, strokeLinecap: 'round', strokeLinejoin: 'round',
        className: props.spinning ? 'dsa-spin' : undefined, 'aria-hidden': true,
      },
        h('path', { d: 'M20.5 12a8.5 8.5 0 1 1-2.5-6' }),
        h('polyline', { points: '20.5 3.5 20.5 9 15 9' }))
    }

    function labelOf(flow, t) {
      if (flow.phase === 'busy') return flow.elapsed > 0 ? `${t('busy')} ${flow.elapsed}s` : t('busy')
      if (flow.phase === 'confirm') return t('confirm')
      if (flow.phase === 'error') return flow.note || t('failed')
      return t('restart')
    }

    /**
     * Plugin ids the supervisor disabled for THIS boot only (automatic crash
     * recovery). The Host clears them after a healthy run, so the badge is
     * expected to disappear on its own — it is a state, not a setting.
     */
    function recoveryIds(flow) {
      const recovery = flow?.lastStatus?.supervisor?.recovery
      const ids = Array.isArray(recovery?.ids) ? recovery.ids.filter((id) => typeof id === 'string' && id !== '') : []
      return ids.length > 0 ? ids : []
    }

    function fillIds(template, ids) {
      return String(template).replace('{ids}', ids.join(', '))
    }

    function titleOf(flow, t) {
      const safeMode = flow.lastStatus?.supervisor?.mode === 'safe'
      const parts = [safeMode ? t('hintSafe') : t('hint')]
      if (safeMode) parts.push(t('safe'))
      const ids = recoveryIds(flow)
      if (ids.length > 0) parts.push(fillIds(t('temporaryDisabledHint'), ids))
      if (flow.note) parts.push(flow.note)
      if (flow.lastStatus === null) parts.push(t('unavailable'))
      return parts.join(' · ')
    }

    /** Warn-tinted pill next to the control; renders nothing when nothing is disabled. */
    function RecoveryBadge(props) {
      const ids = props.ids
      if (ids.length === 0) return null
      return h('span', {
        className: 'dsa-badge',
        title: fillIds(props.t('temporaryDisabledHint'), ids),
        'aria-label': fillIds(props.t('temporaryDisabledAria'), ids),
        'data-dsa-temporary-disabled': ids.join(','),
      }, props.compact ? props.t('temporaryDisabled') : `${props.t('temporaryDisabled')}: ${ids.join(', ')}`)
    }

    /** Compact control for the composer dock (a flex row under the input). */
    function DockControl(props) {
      const t = props.t
      const flow = useFlow('dock')
      const safeMode = flow.lastStatus?.supervisor?.mode === 'safe'
      const ids = recoveryIds(flow)
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: '6px' } },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: ['dsa-btn', flow.phase === 'confirm' || flow.phase === 'error' ? 'dsa-danger' : '', safeMode || ids.length > 0 ? 'dsa-warn' : ''].filter(Boolean).join(' '),
          title: titleOf(flow, t),
          'aria-label': t('restart'),
          'aria-busy': flow.phase === 'busy',
          'data-dsa-phase': flow.phase,
          disabled: flow.phase === 'busy',
          onClick: () => FLOW.activate(),
        },
        h(RestartIcon, { spinning: flow.phase === 'busy' }),
        h('span', null, labelOf(flow, t)),
        safeMode ? h('span', { className: 'dsa-dot' }) : null),
        h(RecoveryBadge, { ids, t, compact: true }))
    }

    /** Full row beside Settings in the sidebar foot; icon-only on the collapsed rail. */
    function SidebarControl(props) {
      const t = props.t
      const wide = props.wide !== false
      const flow = useFlow('sidebar')
      const safeMode = flow.lastStatus?.supervisor?.mode === 'safe'
      const ids = recoveryIds(flow)
      return h('span', { style: { display: 'inline-flex', alignItems: 'center', width: wide ? '100%' : undefined, gap: '6px' } },
        h('style', null, CSS),
        h('button', {
          type: 'button',
          className: ['dsa-row', wide ? '' : 'dsa-rail', safeMode || ids.length > 0 ? 'dsa-warn' : ''].filter(Boolean).join(' '),
          title: titleOf(flow, t),
          'aria-label': t('restart'),
          'aria-busy': flow.phase === 'busy',
          'data-dsa-phase': flow.phase,
          disabled: flow.phase === 'busy',
          onClick: () => FLOW.activate(),
        },
        h(RestartIcon, { spinning: flow.phase === 'busy' }),
        wide ? h('span', { className: 'dsa-rowLabel' }, labelOf(flow, t)) : null,
        safeMode ? h('span', { className: 'dsa-dot' }) : null),
        // The rail is 36px wide: no room for a pill without breaking the layout.
        wide ? h(RecoveryBadge, { ids, t, compact: true }) : null)
    }

    /**
     * Settings → Daemon. Owns one snapshot of the port state and the next-start
     * form. Every fetch is failure-tolerant: an absent route (old host half) or
     * a dead daemon renders a short 不可用 state instead of breaking the panel.
     */
    function PortSection(props) {
      const t = props.t
      const [snapshot, setSnapshot] = React.useState(null)
      const [ready, setReady] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [note, setNote] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      // React.useRef with a stand-in for the dependency-free test stub.
      const live = typeof React.useRef === 'function' ? React.useRef(true) : { current: true }

      const adopt = (next) => {
        if (!live.current) return
        setSnapshot(next)
        // Prefer the port the next start would use, but never seed the input with
        // 0 ("let dsh pick"), which the range check would then reject on save.
        const candidates = [next?.next, next?.current]
        const value = candidates.find((candidate) => Number.isInteger(candidate) && candidate > 0)
        setDraft(value === undefined ? '' : String(value))
      }

      const load = () => {
        readPortSnapshot()
          .then((next) => { adopt(next); if (live.current) setReady(true) })
          .catch(() => { adopt(null); if (live.current) setReady(true) })
      }

      React.useEffect(() => {
        live.current = true
        load()
        return () => { live.current = false }
        // Runs once per mount: the section is remounted whenever it is opened.
      }, [])

      const submit = (restart) => {
        if (busy) return
        const port = parsePortInput(draft)
        if (port === null) {
          setNote({ kind: 'error', text: t('portInvalid') })
          return
        }
        setBusy(true)
        setNote({ kind: 'busy', text: restart ? t('portRestarting') : t('portSaving') })
        let request
        try {
          request = postJson(portQuery(port, restart), '')
        } catch (error) {
          setBusy(false)
          setNote({ kind: 'error', text: `${t('portFailed')} (${String(error?.message ?? error)})` })
          return
        }
        Promise.resolve(request).then(async (response) => {
          let data = null
          try { data = await response.json() } catch { data = null }
          // A restart answers 202 and may carry no JSON body: accept any 2xx and
          // only treat an explicit { ok:false } as a failure. Prefer the host's
          // human message (e.g. "expected an integer 1..65535") over its code.
          if (data && data.ok === false) {
            const detail = data.message || data.error
            throw new Error(detail ? String(detail) : `HTTP ${response.status}`)
          }
          if (!response.ok) throw new Error(`HTTP ${response.status}`)
          return data
        }).then((data) => {
          if (!live.current) return
          setBusy(false)
          // The save response carries the same state shape, so adopt it; if it is
          // empty (bare 202) re-read the live value instead.
          if (data && typeof data === 'object') adopt(data)
          else load()
          setNote({ kind: 'ok', text: restart ? t('portSavedRestart') : t('portSaved') })
        }).catch((error) => {
          if (!live.current) return
          setBusy(false)
          setNote({ kind: 'error', text: `${t('portFailed')} (${String(error?.message ?? error)})` })
        })
      }

      const port = snapshot && typeof snapshot === 'object' ? snapshot : null
      const current = port && Number.isInteger(port.current) ? String(port.current) : null
      const pending = port !== null && (port.pending === true
        || (port.pending === undefined && Number.isInteger(port.next)
          && Number.isInteger(port.current) && port.next !== port.current))
      const noteClass = note?.kind === 'error' ? 'dsa-errText'
        : note?.kind === 'ok' ? 'dsa-okText' : 'dsa-hint'

      return h('div', { className: 'dsa-sec', 'data-dsa-section': 'daemon' },
        h('style', null, CSS),
        h('p', { className: 'dsa-hint' }, t('sectionIntro')),
        h('div', { className: 'dsa-card' },
          h('div', { className: 'dsa-field' },
            h('span', { className: 'dsa-label' }, t('portCurrent')),
            h('span', { className: 'dsa-inline' },
              h('span', {
                className: 'dsa-value',
                'data-dsa-current': current ?? '',
              }, current === null ? t('portUnavailable') : current),
              port ? h('span', { className: 'dsa-hint' }, t(portSourceKey(port.source))) : null)),
          h('div', { className: 'dsa-field' },
            h('label', { className: 'dsa-label', htmlFor: 'dsa-port-next' }, t('portNext')),
            h('span', { className: 'dsa-inline' },
              h('input', {
                id: 'dsa-port-next',
                className: 'dsa-input',
                type: 'number',
                min: 1,
                max: 65535,
                step: 1,
                inputMode: 'numeric',
                value: draft,
                disabled: busy,
                'aria-label': t('portNext'),
                onChange: (event) => {
                  setDraft(event?.target?.value ?? '')
                  if (note && note.kind !== 'ok') setNote(null)
                },
                onKeyDown: (event) => {
                  if (event?.key === 'Enter') {
                    if (typeof event.preventDefault === 'function') event.preventDefault()
                    submit(false)
                  }
                },
              }),
              h('button', {
                type: 'button', className: 'dsa-btn', disabled: busy, onClick: () => submit(false),
              }, t('portSave')),
              h('button', {
                type: 'button', className: 'dsa-btn dsa-primary', disabled: busy, onClick: () => submit(true),
              }, t('portSaveRestart'))),
            pending ? h('p', { className: 'dsa-hint dsa-warnText', 'data-dsa-pending': '1' }, t('portPending')) : null,
            note ? h('p', {
              className: noteClass, 'data-dsa-note': note.kind, role: 'status',
            }, note.text) : null,
            !ready ? h('p', { className: 'dsa-hint' }, t('portLoading')) : null)),
        // The sign-in entry sits right after the port card: it is the answer to
        // "the port changed and my old cookie died". Its own boundary keeps a
        // crash here from taking the port card down with it.
        h(SafeBoundary, { fallback: null }, h(EntrySection, { t })),
        h('div', { className: 'dsa-card' },
          h('div', {
            className: 'dsa-row dsa-disabled',
            'aria-disabled': 'true',
            'data-dsa-experimental': 'cloudflare',
            title: t('cloudflareHint'),
          },
          h('span', { className: 'dsa-rowLabel' }, t('cloudflareLabel')),
          h('span', { className: 'dsa-badge' }, t('cloudflareBadge'))),
          h('p', { className: 'dsa-hint' }, t('cloudflareHint'))))
    }

    /**
     * Settings → Daemon: the stable sign-in entry. The launch cookie is bound to
     * host:port, so a plain URL stops authenticating after a port change; opening
     * this entry once re-issues the cookie. Every fetch and click degrades
     * quietly (unavailable hint, selectable text) instead of throwing.
     */
    function EntrySection(props) {
      const t = props.t
      const [info, setInfo] = React.useState(null)
      const [ready, setReady] = React.useState(false)
      const [note, setNote] = React.useState(null)
      const [reveal, setReveal] = React.useState(null)
      const live = typeof React.useRef === 'function' ? React.useRef(true) : { current: true }

      React.useEffect(() => {
        live.current = true
        readEntryInfo().then((next) => {
          if (!live.current) return
          setInfo(next)
          setReady(true)
        }).catch(() => {
          if (!live.current) return
          setInfo(null)
          setReady(true)
        })
        return () => { live.current = false }
        // Runs once per mount: the section is remounted whenever it is opened.
      }, [])

      const open = () => {
        const url = entryTarget(info)
        if (!url) return
        try {
          window.open(url, '_blank', 'noopener')
        } catch {
          setNote({ kind: 'error', text: t('entryUnavailable') })
        }
      }

      const copy = () => {
        const url = copyTarget(info)
        if (!url) return
        const clipboard = typeof navigator === 'object' && navigator ? navigator.clipboard : null
        let request = null
        try {
          if (clipboard && typeof clipboard.writeText === 'function') request = clipboard.writeText(url)
        } catch {
          request = null
        }
        // No clipboard API (or a synchronous throw): reveal the link instead, so
        // the user can still copy it by hand.
        if (!request || typeof request.then !== 'function') {
          setReveal(url)
          setNote({ kind: 'error', text: t('entryCopyFailed') })
          return
        }
        request.then(() => {
          if (!live.current) return
          setReveal(null)
          setNote({ kind: 'ok', text: t('entryCopied') })
        }).catch(() => {
          if (!live.current) return
          setReveal(url)
          setNote({ kind: 'error', text: t('entryCopyFailed') })
        })
      }

      const entry = info ? textOf(info.entry) : null
      const openable = entryTarget(info)
      const noteClass = note?.kind === 'ok' ? 'dsa-okText' : 'dsa-errText'

      return h('div', {
        className: 'dsa-card',
        'data-dsa-entry': info ? String(info.mode ?? 'unknown') : (ready ? 'unavailable' : 'loading'),
      },
        h('div', { className: 'dsa-field' },
          h('span', { className: 'dsa-label' }, t('entryTitle')),
          h('p', { className: 'dsa-hint' }, t('entryIntro')),
          !ready ? h('p', { className: 'dsa-hint' }, t('portLoading')) : null,
          ready && !openable ? h('p', { className: 'dsa-hint dsa-warnText' }, t('entryUnavailable')) : null),
        entry ? h('div', { className: 'dsa-field' },
          h('span', { className: 'dsa-label' }, t('entryAddress')),
          h('code', { className: 'dsa-url', 'data-dsa-entry-url': entry }, entry),
          h('p', { className: 'dsa-hint' }, t('entryHint'))) : null,
        openable ? h('div', { className: 'dsa-inline' },
          h('button', {
            type: 'button', className: 'dsa-btn dsa-primary', onClick: open,
          }, t('entryOpen')),
          h('button', { type: 'button', className: 'dsa-btn', onClick: copy }, t('entryCopy'))) : null,
        reveal ? h('code', { className: 'dsa-url', 'data-dsa-entry-reveal': '1' }, reveal) : null,
        note ? h('p', {
          className: noteClass, 'data-dsa-entry-note': note.kind, role: 'status',
        }, note.text) : null)
    }

    /** Last-resort settings page: a crash must not blank the panel entry. */
    function PlainSection(props) {
      return h('div', { className: 'dsa-sec' },
        h('p', { className: 'dsa-hint', style: { margin: 0 } }, props.t('portUnavailable')))
    }

    /** Plain, dependency-free control: shown if the styled one ever throws. */
    function PlainControl(props) {
      return h('button', {
        type: 'button',
        title: props.title,
        onClick: fireRestart,
        style: {
          font: 'inherit', fontSize: '12px', lineHeight: 1, cursor: 'pointer',
          background: 'transparent', border: '1px solid currentColor', borderRadius: '6px',
          padding: '4px 10px', color: 'inherit',
        },
      }, props.label)
    }

    /**
     * Per-control isolation. The slot runtime already blanks a crashing entry;
     * this keeps the RESTART ITSELF available instead of leaving an empty cell.
     */
    class SafeBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { failed: false }
      }

      static getDerivedStateFromError() {
        return { failed: true }
      }

      componentDidCatch(error) {
        console.error('dsh-wrainrock-daemon: restart control crashed, using the plain fallback', error)
        report('ui:crashed', { message: String(error?.message ?? error) })
      }

      render() {
        return this.state.failed ? this.props.fallback : this.props.children
      }
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const dicts = { zh, en }
        translate = (key) => dicts.zh[key] ?? key
        const locale = typeof ctx.get === 'function' ? ctx.get('locale') : undefined
        if (locale && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, dicts), 'dsh-wrainrock-daemon: dictionaries')
          try {
            const bound = locale.bind(NS)
            if (typeof bound === 'function') {
              // Never let a locale lookup take the render down.
              translate = (key) => {
                try {
                  const text = bound(key)
                  return typeof text === 'string' && text !== '' && text !== key ? text : (dicts.zh[key] ?? key)
                } catch {
                  return dicts.zh[key] ?? key
                }
              }
            }
          } catch {
            /* keep the bundled zh fallback */
          }
        }
        // Rebuild the flow so its notices use the locale resolved above.
        FLOW = createRestartFlow({ translate })

        const register = (slot, id, order, make, labelKey = 'restart') => ctx.effect(
          () => ctx.slots.inject(slot, () => ctx.slots.register({
            name: slot,
            id,
            order,
            label: () => translate(labelKey),
          }, make)),
          `dsh-wrainrock-daemon: ${id}`,
        )

        register('conversation.composer.dock', 'dsh-wrainrock-daemon', 3,
          () => h(SafeBoundary, { fallback: h(PlainControl, { label: translate('restart'), title: translate('hint') }) },
            h(DockControl, { t: translate })))

        register('sidebar.footer.action', 'dsh-wrainrock-daemon-sidebar', -10,
          (props) => h(SafeBoundary, { fallback: h(PlainControl, { label: translate('restart'), title: translate('hint') }) },
            h(SidebarControl, { t: translate, wide: props?.wide })))

        // Settings → Daemon, slotted between 模型 (10) and 插件 (15).
        register('settings.section', 'daemon', 12,
          () => h(SafeBoundary, { fallback: h(PlainSection, { t: translate }) },
            h(PortSection, { t: translate })),
          'sectionLabel')
      },
      // Test seam: the restart lifecycle is the part that must not regress and
      // the part a browser cannot be driven into reproducing here.
      __test: { createRestartFlow, decideAfterPoll, recoveryIds, fillIds, parsePortInput, portSourceKey, portQuery, readPortSnapshot, readEntryInfo, entryTarget, copyTarget },
    }
  },
})
