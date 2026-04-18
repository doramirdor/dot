/**
 * Capabilities UI (Electron-specific).
 *
 * The pure capabilities logic (state, config, tool-allowed checks) lives
 * in src/core/capabilities.ts and works without Electron. This file adds
 * the BrowserWindow-based HTML UI for the toggles. Standalone-only.
 */
import path from 'node:path'
import { BrowserWindow, ipcMain, screen } from 'electron'
import { fileURLToPath } from 'node:url'

// Re-export everything from the core module so existing callers
// (index.ts, trust.ts) don't need to change their imports if they
// already import from './capabilities.js'.
export {
  type Capability,
  type CapabilitiesState,
  ALL_CAPABILITIES,
  loadCapabilities,
  saveCapabilities,
  isCapabilitiesConfigured,
  isToolAllowed,
  grantFullControl,
  setManualGrants,
} from '../core/capabilities.js'

import {
  loadCapabilities,
  grantFullControl,
  setManualGrants,
  ALL_CAPABILITIES,
  type CapabilitiesState,
} from '../core/capabilities.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// ============ capabilities UI window ============

let capsWindow: BrowserWindow | null = null

export function openCapabilitiesWindow(onDone?: () => void): void {
  if (capsWindow && !capsWindow.isDestroyed()) {
    capsWindow.focus()
    return
  }

  const { workArea } = screen.getPrimaryDisplay()
  const width = 480
  const height = 700

  capsWindow = new BrowserWindow({
    width,
    height,
    x: Math.round(workArea.x + (workArea.width - width) / 2),
    y: Math.round(workArea.y + (workArea.height - height) / 2),
    title: 'Dot — Capabilities',
    resizable: false,
    minimizable: false,
    maximizable: false,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, '../preload/index.mjs'),
    },
  })

  const state = loadCapabilities()
  const html = buildCapabilitiesHTML(state)
  capsWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)

  capsWindow.on('closed', () => {
    capsWindow = null
  })

  const handler = (_e: unknown, action: string, data: unknown) => {
    if (action === 'full-control') {
      grantFullControl()
      console.log('[nina] Full control granted')
      capsWindow?.close()
      onDone?.()
    } else if (action === 'save-manual') {
      setManualGrants(data as Record<string, boolean>)
      console.log('[nina] Manual capabilities saved')
      capsWindow?.close()
      onDone?.()
    }
  }
  ipcMain.handleOnce('caps:action', handler)
}

function buildCapabilitiesHTML(state: CapabilitiesState): string {
  const caps = ALL_CAPABILITIES.map((cap) => {
    const checked = state.mode === 'full' || state.grants[cap.id] === true
    const riskColor = cap.risk === 'safe' ? '#4ade80' : cap.risk === 'moderate' ? '#fbbf24' : '#f87171'
    const riskLabel = cap.risk
    return `
      <div class="cap">
        <div class="cap-header">
          <label class="cap-toggle">
            <input type="checkbox" data-id="${cap.id}" ${checked ? 'checked' : ''}>
            <span class="cap-icon">${cap.icon}</span>
            <span class="cap-name">${cap.name}</span>
          </label>
          <span class="cap-risk" style="color:${riskColor}">${riskLabel}</span>
        </div>
        <div class="cap-desc">${cap.description}</div>
        <div class="cap-examples">${cap.examples.map((e) => `<span class="example">${e}</span>`).join('')}</div>
      </div>
    `
  }).join('')

  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Dot Capabilities</title>
<style>* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: -apple-system, sans-serif; background: #1a1a2e; color: #fffdf5; padding: 24px; overflow-y: auto; }
h1 { font-size: 20px; font-weight: 600; margin-bottom: 4px; }
.subtitle { font-size: 13px; color: #9ca3af; margin-bottom: 20px; }
.full-control { display: flex; align-items: center; gap: 12px; background: linear-gradient(135deg, #2d1b69, #1e3a5f); border: 2px solid #6366f1; border-radius: 12px; padding: 16px; margin-bottom: 20px; cursor: pointer; }
.cap { background: rgba(255,253,245,0.05); border: 1px solid rgba(255,253,245,0.1); border-radius: 10px; padding: 12px 14px; margin-bottom: 10px; }
.cap-header { display: flex; align-items: center; justify-content: space-between; }
.cap-toggle { display: flex; align-items: center; gap: 8px; cursor: pointer; font-size: 14px; }
.cap-toggle input { width: 18px; height: 18px; accent-color: #6366f1; }
.cap-risk { font-size: 11px; font-weight: 600; text-transform: uppercase; }
.cap-desc { font-size: 12px; color: #9ca3af; margin: 6px 0 8px 34px; }
.cap-examples { display: flex; flex-wrap: wrap; gap: 4px; margin-left: 34px; }
.example { font-size: 10px; background: rgba(99,102,241,0.2); color: #a5b4fc; padding: 2px 8px; border-radius: 4px; }
.save-btn { width: 100%; padding: 12px; background: #4f46e5; color: white; border: none; border-radius: 10px; font-size: 14px; font-weight: 600; cursor: pointer; margin-top: 16px; }
</style></head><body>
<h1>what can dot do?</h1>
<p class="subtitle">choose what you're comfortable with.</p>
<div class="full-control" onclick="grantFull()"><span style="font-size:28px">⚡</span><div><h3 style="font-size:15px">Full control — be my Jarvis</h3><p style="font-size:12px;color:#a5b4fc">Enable everything.</p></div></div>
<div style="text-align:center;font-size:11px;color:#6b7280;margin:16px 0">— or choose individually —</div>
${caps}
<button class="save-btn" onclick="saveManual()">Save choices</button>
<script>
function grantFull() { window.close(); }
function saveManual() { window.close(); }
</script>
</body></html>`
}

export function openCapabilitiesWindowAsync(): Promise<{ mode: 'full' | 'manual'; grants: Record<string, boolean> }> {
  return new Promise((resolve) => {
    const state = loadCapabilities()
    const { workArea } = screen.getPrimaryDisplay()
    const win = new BrowserWindow({
      width: 480, height: 700,
      x: Math.round(workArea.x + (workArea.width - 480) / 2),
      y: Math.round(workArea.y + (workArea.height - 700) / 2),
      title: 'Dot — Capabilities',
      resizable: false, minimizable: false, maximizable: false,
      webPreferences: { nodeIntegration: false, contextIsolation: false },
    })
    win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(buildCapabilitiesHTML(state))}`)
    win.on('closed', async () => {
      try {
        const action = await win.webContents.executeJavaScript('window.__capsAction || null')
        if (action === 'full-control') { grantFullControl(); resolve({ mode: 'full', grants: {} }) }
        else if (action === 'save-manual') {
          const grants = await win.webContents.executeJavaScript('window.__capsData || {}') as Record<string, boolean>
          setManualGrants(grants); resolve({ mode: 'manual', grants })
        } else { resolve({ mode: state.mode === 'unconfigured' ? 'full' : state.mode, grants: state.grants }) }
      } catch { resolve({ mode: state.mode === 'unconfigured' ? 'full' : state.mode, grants: state.grants }) }
    })
  })
}
