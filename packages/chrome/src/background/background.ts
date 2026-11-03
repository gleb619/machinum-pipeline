import type { TypeContentRequest, UploadRequest } from '../messages'

/**
 * Default backend: the admin API (`mt serve`) that serves
 * `POST /api/runs/:id/items`. Port 3000 is `mt serve`'s default — 7777 is the
 * *router* (LLM gateway) port and has no runs API.
 */
const DEFAULT_BACKEND_URL = 'http://localhost:3000'

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({ backendUrl: DEFAULT_BACKEND_URL })
})

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message.type === 'upload') {
    const { runId, backendUrl, item } = message as UploadRequest
    fetch(`${backendUrl}/api/runs/${runId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(item),
    })
      .then((res) => {
        sendResponse({ success: res.ok })
      })
      .catch((err) => {
        sendResponse({ success: false, error: String(err) })
      })
    return true
  }

  if (message.type === 'typeContent') {
    const { selector, text } = message as TypeContentRequest
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const tab = tabs[0]
      if (!tab?.id) {
        sendResponse({ success: false, error: 'No active tab' })
        return
      }
      chrome.scripting.executeScript(
        {
          target: { tabId: tab.id },
          func: (sel: string, txt: string) => {
            const el = document.querySelector(sel) as HTMLInputElement | HTMLTextAreaElement
            if (el) {
              el.focus()
              el.value = txt
              el.dispatchEvent(new Event('input', { bubbles: true }))
              el.dispatchEvent(new Event('change', { bubbles: true }))
              return true
            }
            return false
          },
          args: [selector, text],
        },
        (results) => {
          const success = results?.[0]?.result ?? false
          sendResponse({ success })
        },
      )
    })
    return true
  }

  return false
})
