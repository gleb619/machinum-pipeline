Analyze the following name similarity data and consolidate into unique related names.

Current Name: {{term}}
Current Description: {{description}}

List 1 - Initial Similar Names:
{{similarNames}}

List 2 - Contextually Similar Names:
{{contextualSimilarNames}}

List 3 - Additional Context Descriptions:
{{additionalDescriptions}}

Task:

1. Identify names that refer to the same entity (considering spelling variations, typos, phonetic similarity)
2. Consolidate similar names into canonical forms
3. Correct obvious misspellings
4. Merge semantically equivalent names
5. List the names that are semantically related to the current name (use only the names of the lists above, put them in
"relatedNames")

Output JSON format:
[
{
"consolidatedName": "Corrected Canonical Name",
"originalNames": ["name1", "name2"],
"relatedNames": ["name3"],
"confidence": 0.95,
"reason": "Phonetic similarity and semantic context match"
}
]

Only return the JSON array, no additional text.
