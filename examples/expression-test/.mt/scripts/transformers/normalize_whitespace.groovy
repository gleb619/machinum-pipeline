// Transformer: Normalize whitespace and line breaks
// Input: text variable
// Output: normalized text with consistent spacing

return text
    ?.replaceAll('\\s+', ' ')  // Collapse multiple spaces
    .replaceAll('\\n\\s*\\n', '\n\n')  // Normalize paragraph breaks
    .trim()
