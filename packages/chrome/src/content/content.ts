import type { ScrapeRequest, ScrapeResponse } from '../messages'

export function scrapePage(): { title: string; content: string } {
  const content = document.body.innerText
  return {
    title: document.title,
    content: content.substring(0, 50000),
  }
}

chrome.runtime.onMessage.addListener((message: ScrapeRequest, _sender, sendResponse) => {
  if (message.type === 'scrape') {
    const result = scrapePage()
    const response: ScrapeResponse = {
      title: result.title,
      content: result.content,
      url: window.location.href,
    }
    sendResponse(response)
  }
  return true
})
