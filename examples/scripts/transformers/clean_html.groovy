// Transformer: Clean HTML entities and special characters
// Input: text variable
// Output: cleaned text

def cleaned = text
    ?.replaceAll('&nbsp;', ' ')
    .replaceAll('&amp;', '&')
    .replaceAll('&lt;', '<')
    .replaceAll('&gt;', '>')
    .replaceAll('&quot;', '"')
    .replaceAll('&#39;', "'")
    .replaceAll('<[^>]*>', '')  // Remove HTML tags
    .trim()

return cleaned
