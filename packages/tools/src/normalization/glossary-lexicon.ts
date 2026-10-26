/**
 * Word lists shared by the glossary heuristics (candidate scan, type guess, NER seeding).
 *
 * Kept in its own module so the extractor and the NER backend can use the same lists
 * without an import cycle.
 */

/** Very common English words (lower-cased): never a proper name on their own. */
export const COMMON_WORDS: ReadonlySet<string> = new Set(
  (
    'The A An He She It They We I You His Her Its Their Our Your My This That These Those What ' +
    'When Where Why How Who Whom Which But And Or So Then Now If As At In On Of To For With ' +
    'Without By From After Before Chapter Yes No Not Just Even Still There Here Suddenly Perhaps ' +
    'Maybe Please Thank Thanks Well Oh Ah Hmm Okay Ok Once Every Some Many Most Each Both All ' +
    'Another Other Only Also Though Although While Because Since Until Unless Whether Either ' +
    'Neither Nothing Something Anything Everything Someone Anyone Everyone Mr Mrs Ms Dr Sir ' +
    'Do Does Did Is Are Was Were Be Can Could Would Should Will Shall May Might Must Let Look ' +
    'See Come Go Get Got Take Make Know Think Tell Say Said Ask Asked Wait Stop Listen Sorry ' +
    'Good Great Little Big Old New First Last Next One Two Three Four Five Six Seven Eight Nine Ten ' +
    'Today Tomorrow Yesterday Tonight Monday Tuesday Wednesday Thursday Friday Saturday Sunday ' +
    'Never Always Maybe Really Actually Finally Instead Meanwhile However Therefore Besides ' +
    'Later Soon Earlier Afterward Eventually Slowly Quickly Then Again Perhaps Inside Outside Behind Above Below Beyond Between Through During Within Against Among'
  )
    .split(' ')
    .map((w) => w.toLowerCase()),
)

/** Last word of a term that marks a place. */
export const PLACE_WORDS =
  /^(City|Kingdom|Mountains?|Forest|River|Lake|Valley|Castle|Village|Town|Temple|Realm|Island|Sea|Desert|Cave|Tower|Gate|Hall|Capital|Plains|Hills?|Swamp|Fortress|Fort|Keep|Citadel|Abbey|Monastery|Basilica|Court|Camp|Station|Docks|Harbor|Port|Market|Crossroads|Square|Street|Alley|Yard|Base|Depot|Lodge|Ridge|Hill|Dale|Glen|Cove|Bay|Grotto|Tavern|Inn|Peak|Canyon|Ruins|Land|Lands|Mount|Mt)$/

/** Last word of a term that marks an object. */
export const ITEM_WORDS =
  /^(Sword|Blade|Ring|Staff|Amulet|Potion|Stone|Armor|Armour|Shield|Crown|Orb|Elixir|Scroll|Bow|Axe|Key|Cloak|Dagger|Spear|Pendant|Necklace|Helm|Helmet|Gauntlets?|Boots|Wand|Tome|Book|Crystal|Gem|Pill|Egg)$/

/** Last word of a term that marks an ability. */
export const SKILL_WORDS =
  /^(Strike|Slash|Blast|Bolt|Art|Arts|Technique|Skill|Spell|Breath|Aura|Style|Burst|Form|Dash|Shot|Fire|Fireball|Heal|Healing|Step|Shield|Barrier|Roar|Charge|Smash|Cleave|Mastery|Sense|Vision|Resistance)$/

/** Last word of a term that marks a faction, rank or other abstract concept. */
export const CONCEPT_WORDS =
  /^(Order|Guild|Sect|Clan|Academy|Empire|Church|System|Class|Rank|Council|Army|Legion|Alliance|Dynasty|House|Tribe|Race|Level|Quest|Status|Title|Realm|Dragons?|Elf|Elves|Dwarf|Dwarves|Orc|Orcs)$/

/** Last word of a term that marks an organisation (a NER organisation kind). */
export const ORG_WORDS =
  /^(Order|Guild|Sect|Clan|Academy|Empire|Church|Council|Army|Legion|Alliance|Dynasty|House|Tribe|Company|Brotherhood|Circle|Union|Federation)$/

/** True when the word (any case) is a common English word. */
export function isCommonWord(word: string): boolean {
  return COMMON_WORDS.has(word.toLowerCase())
}
