import { translateFlow } from '../lib/translate-flow.js'

// === translate, work mode `xml`: lines wrapped as <result><id>N</id><origin>..</origin></result> ===
// Judge: the model keeps the ids (a missing / duplicate id is retried); compare with `plain`.
export default translateFlow('xml')
