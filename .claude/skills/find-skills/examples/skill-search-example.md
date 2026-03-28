# Find Skills Examples

Example scenarios demonstrating how to use the find-skills skill effectively.

## Example 1: Finding a React Performance Skill

**User Request**: "How do I make my React app faster?"

**Process**:

1. **Understand Need**: Domain = React, Task = performance optimization
2. **Check Leaderboard**: Visit skills.sh — `vercel-labs/agent-skills` has React skills
3. **Search**: `npx skills find react performance`
4. **Verify**: Check install count (185K+), source (`vercel-labs`), GitHub stars
5. **Present**:

```text
I found a skill that might help! The "react-best-practices" skill provides
React and Next.js performance optimization guidelines from Vercel Engineering.
(185K installs)

To install it:
npx skills add vercel-labs/agent-skills@react-best-practices

Learn more: https://skills.sh/vercel-labs/agent-skills/react-best-practices
```

6. **Install** (if user agrees): `npx skills add vercel-labs/agent-skills@react-best-practices -g -y`

## Example 2: Finding a PR Review Skill

**User Request**: "Can you help me with PR reviews?"

**Process**:

1. **Understand Need**: Domain = Code Quality, Task = PR review
2. **Check Leaderboard**: No direct match in top skills
3. **Search**: `npx skills find pr review`
4. **Verify**: Check install count, source reputation, GitHub stars
5. **Present**: Show results with install commands and skills.sh links
6. **Install** (if user agrees)

## Example 3: No Results Found

**User Request**: "Find a skill for quantum computing simulations"

**Process**:

1. **Understand Need**: Domain = Quantum Computing, Task = simulations
2. **Check Leaderboard**: No match
3. **Search**: `npx skills find quantum computing`
4. **Result**: No skills found

**Response**:

```text
I searched for skills related to "quantum computing simulations" but didn't find any matches.
I can still help you with this task directly! Would you like me to proceed?

If this is something you do often, you could create your own skill:
npx skills init my-quantum-skill
```

## Example 4: Java/Gradle Skill Search

**User Request**: "Is there a skill for Gradle build optimization?"

**Process**:

1. **Understand Need**: Domain = Java/Gradle, Task = build optimization
2. **Check Local Skills**: Project already has `.claude/skills/` and `.qwen/skills/gradle-build/`
3. **Decision**: Local skill exists — use it first before searching external sources
4. **If external needed**: `npx skills find gradle build`

## Example 5: Testing Skill Search

**User Request**: "Find a skill for Playwright E2E testing"

**Process**:

1. **Understand Need**: Domain = Testing, Task = E2E with Playwright
2. **Check Leaderboard**: Check skills.sh for testing skills
3. **Search**: `npx skills find playwright testing`
4. **Verify**: Install count, source, GitHub stars
5. **Present**: Show results with quality indicators

## Quality Verification Checklist

Before recommending any skill:

- [ ] Install count >= 1,000 (prefer 10K+)
- [ ] Source is reputable (vercel-labs, anthropics, microsoft, etc.)
- [ ] GitHub repo has >= 100 stars
- [ ] Skill description matches user's actual need
- [ ] No duplicate with existing local skills

## Integration Notes

When searching for external skills:

1. Check `.claude/skills/` for existing local skills first
2. Check `.qwen/skills/` for Qwen-compatible skills
3. Search external sources only if local skills don't cover the need
4. External skills should complement, not replace, local skills