/** Built-in EN fixture: original short fantasy/apocalypse paragraphs + glossary (term -> ru). */
export interface Fixture {
  paragraphs: string[]
  glossary: Record<string, string>
}

export const FIXTURE: Fixture = {
  paragraphs: [
    'Ashfall had buried the village of Karrowmere for nine days when Veyra Thorne finally climbed out of the cellar. The sky was the colour of old iron, and the Hollow Bell on the chapel roof had stopped ringing.',
    '"Do not touch the ash," warned Brannoch, the one-eyed smith, without turning around. "It remembers who it burned."',
    'Veyra tightened the strap of her satchel, which held the last shard of the Emberglass. Whatever the Pale Choir wanted with it, they would have to take it from her cold hands.',
    'By dusk they reached the Gravewood, where the trees grew downward from the clouds and the roots hummed with a sound like distant prayer. Brannoch lit a torch, and the shadows leaned away from the flame.',
    '"Three days to the Citadel of Sorrow," he said. "If the Ashen Court has not fallen by then, we may yet end this."',
    'Veyra did not answer. Far behind them, the Hollow Bell rang once, and no one was left in Karrowmere to pull the rope.',
  ],
  glossary: {
    Veyra: 'Вейра',
    Brannoch: 'Браннох',
    Karrowmere: 'Каррумир',
    Emberglass: 'Янтарное Стекло',
    'Pale Choir': 'Бледный Хор',
    Gravewood: 'Могильный Лес',
    'Citadel of Sorrow': 'Цитадель Скорби',
    'Ashen Court': 'Пепельный Двор',
    'Hollow Bell': 'Полый Колокол',
  },
}
