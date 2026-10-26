import { translateFlow } from '../lib/translate-flow.js'

// === translate, work mode `properties`: lines wrapped as `N=text`, reply is `N=translation` ===
// Judge: keys stay 1..N, no merged / split lines; compare with `plain`.
export default translateFlow('properties')
