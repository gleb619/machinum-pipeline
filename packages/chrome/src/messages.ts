export interface ScrapeRequest {
  type: 'scrape'
}

export interface ScrapeResponse {
  title: string
  content: string
  url: string
}

export interface UploadRequest {
  type: 'upload'
  runId: string
  backendUrl: string
  item: {
    title: string
    url: string
    content: string
  }
}

export interface TypeContentRequest {
  type: 'typeContent'
  selector: string
  text: string
}
