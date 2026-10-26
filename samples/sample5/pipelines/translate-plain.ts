import { translateFlow } from '../lib/translate-flow.js'

// === translate, work mode `plain`: the model answers with the bare translation ===
// Judge: glossary names (input/glossary.json: Sir Aldric -> сэр Алдрик, Elara, Thornhaven,
// Darkwood) are rendered exactly as listed, one RU line per EN line, natural Russian.
export default translateFlow('plain')
