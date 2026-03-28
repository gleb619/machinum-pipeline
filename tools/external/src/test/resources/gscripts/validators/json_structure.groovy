// Validate JSON structure
if (!(item instanceof Map)) {
  return [valid: false, error: 'Item must be a Map']
}
def requiredFields = ['id', 'type']
def missing = requiredFields.findAll {!item.containsKey(it)}
if (missing) {
  return [valid: false, error: "Missing fields: ${missing.join(', ')}"]
}
return [valid: true]
