/**
 * Provider setup UI (Electron).
 *
 * First-run flow: when Dot boots and no credential is available for any
 * Agent-SDK-routable provider, this window is opened before chat input
 * is allowed. Also invokable on demand from the tray or the `/provider`
 * command so the user can re-key, switch providers, or rotate secrets.
 *
 * The window renders a simple HTML form that:
 *   - lists every provider from `listProviders()` with current status
 *   - lets the user paste a credential (Anthropic / OpenAI)
 *   - offers an explicit "import from openclaw" button when
 *     `findLegacyOpenclawToken()` returns a value — never auto-stolen
 *   - for Bedrock / Vertex: shows hints about `~/.aws/credentials` or
 *     `gcloud auth application-default login` (no Keychain involved)
 *
 * Submit writes through the existing providers.ts helpers:
 *   - `storeProviderCredential(id, value)` → Keychain
 *   - `setPreferredProvider(id, model?)` → ~/.dot/config.json
 *
 * The window resolves a promise when the user clicks Save or closes it,
 * so the caller can gate startup on "at least one provider is ready".
 */
import path from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { fileURLToPath } from 'node:url'
import {
  listProviders,
  setPreferredProvider,
  storeProviderCredential,
  findLegacyOpenclawToken,
  type ProviderConfig,
  type ProviderId,
} from '../core/providers.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

let setupWindow: BrowserWindow | null = null

export interface ProviderSetupResult {
  saved: boolean
  providerId?: ProviderId
}

/**
 * Open the provider-setup window. Resolves when the window closes. If
 * `saved` is true, at least one credential was stored and a preferred
 * provider was written. Safe to call multiple times — a second call while
 * the window is open focuses the existing one and resolves once it closes.
 */
export function openProviderSetupWindow(): Promise<ProviderSetupResult> {
  return new Promise((resolve) => {
    if (setupWindow && !setupWindow.isDestroyed()) {
      setupWindow.focus()
      setupWindow.once('closed', () => resolve({ saved: false }))
      return
    }

    const { workArea } = screen.getPrimaryDisplay()
    const width = 520
    const height = 640

    setupWindow = new BrowserWindow({
      width,
      height,
      x: Math.round(workArea.x + (workArea.width - width) / 2),
      y: Math.round(workArea.y + (workArea.height - height) / 2),
      title: 'Dot — Provider setup',
      resizable: false,
      minimizable: false,
      maximizable: false,
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        preload: path.join(__dirname, '../preload/index.mjs'),
      },
    })

    const providers = listProviders()
    const legacyToken = findLegacyOpenclawToken()
    const html = buildSetupHTML(providers, legacyToken !== null)
    setupWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

    let savedResult: ProviderSetupResult = { saved: false }

    const saveHandler = (
      _e: unknown,
      payload: {
        providerId: ProviderId
        credential?: string
        model?: string
        importOpenclaw?: boolean
      },
    ) => {
      const { providerId, credential, model, importOpenclaw } = payload
      let wrote = false

      if (importOpenclaw && legacyToken && providerId === 'anthropic') {
        wrote = storeProviderCredential('anthropic', legacyToken)
      } else if (credential && credential.trim().length >= 10) {
        wrote = storeProviderCredential(providerId, credential.trim())
      } else if (providerId === 'bedrock' || providerId === 'vertex') {
        // These providers read creds from their native locations. Just
        // persist the choice — no Keychain write needed.
        wrote = true
      }

      if (wrote) {
        try {
          setPreferredProvider(providerId, model && model.trim() ? model.trim() : undefined)
          savedResult = { saved: true, providerId }
        } catch (err) {
          console.warn('[provider-setup] setPreferredProvider failed:', err)
        }
      }

      // Don't close here — the renderer calls window.close() after this
      // handler resolves, and closing before the IPC reply can strand the
      // renderer-side await.
      return wrote
    }

    // Use `handle` (not `handleOnce`) so re-opens re-register cleanly, and
    // remove on close so we don't leak handlers.
    ipcMain.removeHandler('provider-setup:save')
    ipcMain.handle('provider-setup:save', saveHandler)

    setupWindow.on('closed', () => {
      setupWindow = null
      ipcMain.removeHandler('provider-setup:save')
      resolve(savedResult)
    })
  })
}

function buildSetupHTML(providers: ProviderConfig[], hasLegacy: boolean): string {
  const rows = providers
    .map((p) => {
      const statusColor = p.ready ? '#4ade80' : '#9ca3af'
      const statusLabel = p.ready ? `ready · ${p.credentialSource}` : 'not configured'
      const routable = p.supportedByAgentSDK
        ? ''
        : '<span class="badge">storage only — not routable yet</span>'
      return `
        <label class="row">
          <input type="radio" name="provider" value="${p.id}" ${p.ready ? '' : ''} />
          <div class="row-body">
            <div class="row-head">
              <span class="row-name">${escapeHtml(p.label)}</span>
              <span class="row-status" style="color:${statusColor}">${escapeHtml(statusLabel)}</span>
            </div>
            <div class="row-id">${p.id} ${routable}</div>
          </div>
        </label>
      `
    })
    .join('')

  const legacyBanner = hasLegacy
    ? `
    <div class="legacy">
      <strong>Found an openclaw Anthropic token on disk.</strong>
      Dot does not read this automatically. Tick below to import it into the macOS Keychain — you can also just ignore it and paste your own key.
      <label class="legacy-opt"><input type="checkbox" id="import-openclaw" /> Import openclaw token when I click Save</label>
    </div>
  `
    : ''

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Dot — Provider setup</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #fffdf5; padding: 24px; overflow-y: auto; }
  h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
  .subtitle { font-size: 13px; color: #9ca3af; margin-bottom: 18px; }
  .row { display: flex; gap: 12px; align-items: flex-start; background: rgba(255,253,245,0.05); border: 1px solid rgba(255,253,245,0.1); border-radius: 10px; padding: 12px 14px; margin-bottom: 8px; cursor: pointer; }
  .row input[type=radio] { margin-top: 4px; accent-color: #6366f1; }
  .row-body { flex: 1; }
  .row-head { display: flex; justify-content: space-between; font-size: 14px; }
  .row-name { font-weight: 600; }
  .row-status { font-size: 11px; text-transform: lowercase; }
  .row-id { font-size: 11px; color: #6b7280; margin-top: 2px; font-family: ui-monospace, SFMono-Regular, monospace; }
  .badge { background: rgba(251,191,36,0.15); color: #fbbf24; padding: 1px 6px; border-radius: 4px; margin-left: 6px; font-size: 10px; }
  .legacy { background: rgba(99,102,241,0.1); border: 1px solid rgba(99,102,241,0.4); border-radius: 10px; padding: 12px 14px; margin: 12px 0 16px; font-size: 12px; color: #c7d2fe; }
  .legacy strong { display: block; margin-bottom: 4px; color: #a5b4fc; }
  .legacy-opt { display: flex; align-items: center; gap: 8px; margin-top: 8px; cursor: pointer; }
  .cred-block { margin-top: 16px; }
  .cred-block label { display: block; font-size: 12px; color: #9ca3af; margin-bottom: 6px; }
  .cred-block input { width: 100%; padding: 10px 12px; background: rgba(0,0,0,0.25); border: 1px solid rgba(255,253,245,0.1); border-radius: 8px; color: #fffdf5; font-family: ui-monospace, SFMono-Regular, monospace; font-size: 12px; }
  .cred-block input:focus { outline: none; border-color: #6366f1; }
  .hint { font-size: 11px; color: #6b7280; margin-top: 6px; line-height: 1.4; }
  .save-btn { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 18px; }
  .save-btn:disabled { opacity: 0.5; cursor: not-allowed; }
  .cancel-btn { width: 100%; padding: 10px; background: transparent; color: #9ca3af; border: 1px solid rgba(255,253,245,0.1); border-radius: 10px; font-size: 13px; cursor: pointer; margin-top: 8px; }
</style></head><body>
  <h1>connect a provider</h1>
  <p class="subtitle">pick who powers Dot's brain. stored in macOS Keychain — never written to config.json.</p>
  ${legacyBanner}
  <div id="providers">${rows}</div>
  <div class="cred-block" id="cred-block"></div>
  <button class="save-btn" id="save" disabled>Save</button>
  <button class="cancel-btn" id="cancel">Skip for now</button>
<script>
  const api = window.nina || {}
  const providers = ${JSON.stringify(providers)}
  const hasLegacy = ${JSON.stringify(hasLegacy)}
  const credBlock = document.getElementById('cred-block')
  const saveBtn = document.getElementById('save')
  const cancelBtn = document.getElementById('cancel')
  let selected = null

  function render() {
    if (!selected) { credBlock.innerHTML = ''; saveBtn.disabled = true; return }
    const p = providers.find(x => x.id === selected)
    if (selected === 'anthropic') {
      credBlock.innerHTML = \`
        <label>Anthropic API key or OAuth token</label>
        <input id="cred" type="password" placeholder="sk-ant-... or sk-ant-oat-..." autocomplete="off" />
        <div class="hint">Create a key at console.anthropic.com, or run <code>claude setup-token</code> in a terminal to get an OAuth token tied to your Claude subscription.</div>
        <label style="margin-top:12px">Model (optional)</label>
        <input id="model" type="text" placeholder="claude-opus-4-7 (leave blank for SDK default)" autocomplete="off" />
      \`
    } else if (selected === 'openai') {
      credBlock.innerHTML = \`
        <label>OpenAI API key (stored but not yet routable)</label>
        <input id="cred" type="password" placeholder="sk-..." autocomplete="off" />
        <div class="hint">Dot stores this in Keychain for future use. Agent calls still go through an Anthropic-compatible provider today.</div>
      \`
    } else if (selected === 'bedrock') {
      credBlock.innerHTML = \`
        <div class="hint">Bedrock reads AWS credentials from the standard chain. Make sure one of these is set:<br>
        • <code>~/.aws/credentials</code> with a profile<br>
        • <code>AWS_ACCESS_KEY_ID</code> + <code>AWS_SECRET_ACCESS_KEY</code> env vars<br>
        • An IAM role (EC2 / ECS)</div>
        <label style="margin-top:12px">Model (optional)</label>
        <input id="model" type="text" placeholder="us.anthropic.claude-opus-4-20250805-v1:0" autocomplete="off" />
      \`
    } else if (selected === 'vertex') {
      credBlock.innerHTML = \`
        <div class="hint">Vertex uses Google application-default credentials. Run:<br>
        <code>gcloud auth application-default login</code><br>
        or set <code>GOOGLE_APPLICATION_CREDENTIALS</code> to a service-account JSON.</div>
        <label style="margin-top:12px">Model (optional)</label>
        <input id="model" type="text" placeholder="claude-opus-4@20250805" autocomplete="off" />
      \`
    }
    updateSaveState()
  }

  function updateSaveState() {
    if (!selected) { saveBtn.disabled = true; return }
    const importBox = document.getElementById('import-openclaw')
    const importing = importBox && importBox.checked && selected === 'anthropic'
    const credInput = document.getElementById('cred')
    const credFilled = credInput && credInput.value.trim().length >= 10
    const needsCred = selected === 'anthropic' || selected === 'openai'
    saveBtn.disabled = needsCred ? !(importing || credFilled) : false
  }

  document.getElementById('providers').addEventListener('change', (e) => {
    if (e.target && e.target.name === 'provider') { selected = e.target.value; render() }
  })
  document.addEventListener('input', (e) => {
    if (e.target && (e.target.id === 'cred' || e.target.id === 'import-openclaw')) updateSaveState()
  })
  document.addEventListener('change', (e) => {
    if (e.target && e.target.id === 'import-openclaw') updateSaveState()
  })

  saveBtn.addEventListener('click', async () => {
    const credEl = document.getElementById('cred')
    const modelEl = document.getElementById('model')
    const importEl = document.getElementById('import-openclaw')
    const payload = {
      providerId: selected,
      credential: credEl ? credEl.value : undefined,
      model: modelEl ? modelEl.value : undefined,
      importOpenclaw: !!(importEl && importEl.checked),
    }
    saveBtn.disabled = true
    if (api.providerSetupSave) {
      try { await api.providerSetupSave(payload) } catch (e) { console.error(e) }
    }
    window.close()
  })
  cancelBtn.addEventListener('click', () => window.close())
</script>
</body></html>`
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&': return '&amp;'
      case '<': return '&lt;'
      case '>': return '&gt;'
      case '"': return '&quot;'
      case "'": return '&#39;'
      default: return c
    }
  })
}
