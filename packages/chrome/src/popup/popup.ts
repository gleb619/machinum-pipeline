import type { ScrapeRequest, UploadRequest } from '../messages'

const backendUrlInput = document.getElementById('backendUrl') as HTMLInputElement
const runIdInput = document.getElementById('runId') as HTMLInputElement
const scrapeBtn = document.getElementById('scrapeBtn') as HTMLButtonElement
const statusEl = document.getElementById('status') as HTMLDivElement

function setStatus(message: string, isError = false) {
  statusEl.textContent = message
  statusEl.style.color = isError ? '#e94560' : '#aaa'
}

async function loadSettings() {
  const result = await chrome.storage.local.get(['backendUrl', 'runId'])
  if (result.backendUrl) backendUrlInput.value = result.backendUrl
  if (result.runId) runIdInput.value = result.runId
}

async function saveSettings() {
  await chrome.storage.local.set({
    backendUrl: backendUrlInput.value,
    runId: runIdInput.value,
  })
}

async function scrapePage(tabId: number): Promise<{ title: string; content: string; url: string }> {
  const response = await chrome.tabs.sendMessage(tabId, { type: 'scrape' } as ScrapeRequest)
  return response
}

async function scrapeBtnClick() {
  const backendUrl = backendUrlInput.value.trim()
  const runId = runIdInput.value.trim()

  if (!backendUrl) {
    setStatus('Please enter backend URL', true)
    return
  }
  if (!runId) {
    setStatus('Please enter Run ID', true)
    return
  }

  await saveSettings()
  scrapeBtn.disabled = true
  setStatus('Scraping page...')

  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.id) {
      setStatus('No active tab found', true)
      return
    }

    const scrapeResult = await scrapePage(tab.id)
    setStatus('Uploading to backend...')

    const uploadResponse = await fetch(`${backendUrl}/api/runs/${runId}/items`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        title: scrapeResult.title,
        url: scrapeResult.url,
        content: scrapeResult.content,
      }),
    })

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status}`)
    }

    setStatus('Success! Page scraped and uploaded.')
  } catch (err) {
    setStatus(`Error: ${err instanceof Error ? err.message : String(err)}`, true)
  } finally {
    scrapeBtn.disabled = false
  }
}

scrapeBtn.addEventListener('click', scrapeBtnClick)
loadSettings()
