export function truncateString(text: string, maxLength: number, suffix = '...'): string {
  if (!text || maxLength <= 0) return ''
  if (text.length <= maxLength) return text
  return text.slice(0, maxLength) + suffix
}
