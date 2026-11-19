/** Names the offline mock proposes; the hallucination never occurs in book2 (R3 fixture). */
export const MOCK_NER_NAMES = ['Nadia Okonkwo', 'Emeka Okonkwo', 'Marrow Bay']
export const MOCK_NER_HALLUCINATION = 'Zephyr Quillon'

export const MOCK_NER_ANSWER = JSON.stringify([
  {
    name: 'Nadia Okonkwo',
    category: 'Character',
    description: 'An audio archivist searching for her missing brother.',
    references: [],
  },
  {
    name: 'Emeka Okonkwo',
    category: 'Character',
    description: 'Nadia’s brother, missing since the Pelargic sank.',
    references: [],
  },
  {
    name: 'Marrow Bay',
    category: 'Location',
    description: 'The coastal town where the archive sits.',
    references: [],
  },
  {
    name: MOCK_NER_HALLUCINATION,
    category: 'Character',
    description: 'An invented archivist who never appears in the book.',
    references: [],
  },
])
