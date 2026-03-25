// Condition: Check if text is valid for processing
// Returns true if text is not empty and meets minimum length requirement

def minLength = 10
return text != null && text.trim().length() >= minLength
