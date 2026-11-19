/**
 * JSON in the repo formatter's shape: Biome keeps short arrays inline. Long arrays stay one
 * value per line.
 */
export function compactArrays(json: string): string {
  return json.replace(/\[\n([^[\]]*?)\n(\s*)\]/g, (match, body: string, indent: string) => {
    const values = body
      .split(/,\n/)
      .map((value) => value.trim())
      .filter((value) => value !== '')
    const inline = `[${values.join(', ')}]`
    return indent.length + inline.length <= 100 ? inline : match
  })
}
