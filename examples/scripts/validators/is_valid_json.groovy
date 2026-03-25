// Validator: Check if content is valid JSON
// Input: item map with 'content' key
// Output: true if valid JSON, false otherwise

def item = arg
if (item == null || !item.containsKey('content')) {
    return false
}

def content = item.get('content')
if (content == null || content.trim().isEmpty()) {
    return false
}

try {
    // Try to parse as JSON
    def slurper = new groovy.json.JsonSlurper()
    slurper.parseText(content.trim())
    return true
} catch (Exception e) {
    return false
}
