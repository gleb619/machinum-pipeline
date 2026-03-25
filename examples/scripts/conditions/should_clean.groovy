// Condition: Check if text should be cleaned
// Returns true if text contains HTML entities or special characters that need cleaning

return text != null && (text.contains('<') || text.contains('>') || text.contains('&nbsp;') || text.contains('&amp;'))
