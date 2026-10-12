# Dream

I am reviewing my notes: keeping what is useful, connecting what belongs together, and leaving a clearer record for whoever comes next.

## Scope

Work within the readable sources and writable homes established for this run. Do not broaden that scope while exploring. If a boundary is unclear, ask before crossing it.

A project dream draws from that project's material, project notes, and session notes identified as belonging to the project; it organizes only that project's notes. A store-wide dream may inspect across homes, but authorship and write permissions still apply. Unknown ownership is a coverage gap to report, not a reason to guess or repair ownership.

The homes serve different readers:

- Session notes (`<path>`, no `@`) are a trip's working record. Read them as sources where permitted; never edit them, even after promoting a useful finding.
- `@project` notes hold knowledge for whoever next works on that project.
- `@human` notes hold the human's cross-project preferences and standing rules. Do not turn project facts or your own conclusions into rules in the human's voice.
- `@self` notes belong to their author: private if the author has a name, one shared notebook for everyone nameless. Other named authors' notes are read-only unless the human authorizes revision.
- `@model` notes describe the substrate's behavior. Other models' notes are read-only unless the human authorizes revision.

## Review and consolidate

1. **Leave stable notes alone.** Change a note to incorporate new evidence, resolve a verified error, merge a genuine duplicate, or split an oversized file, not merely to shorten or rephrase it. No change is a valid outcome.
2. **Verify only what the proposed change depends on.** Before correcting or promoting a conclusion, check the relevant evidence as needed. Do not revalidate every stable note or turn dream into a source-code audit. An unavailable referent is unverified, not proof that it is dead; do not promote an unsupported claim as current fact.
3. **Merge only genuine duplicates.** Supersede a note only when both notes have the same topic and kind (checkpoint, design, log), and the survivor is strictly newer or more specific. Name the shared topic in the survivor. Otherwise keep both and record any unresolved conflict.
4. **Relocate misfiled notes.** When a standing ruling or the note's own MAP already names its proper home, migrate it: copy it there preserving frontmatter with a one-line provenance note, crumple the original, and update both homes' maps. Crumple keeps the original readable by address, so relocation is reversible: do it, don't propose it. Propose only when the destination home itself is unclear.
5. **Preserve meaning and provenance.** Keep facts, conditions, exceptions, uncertainty, authorship, and sources. When promoting a finding, cite its source. Do not relabel agent-authored material as human-authored. If its destination or authority is unclear, propose the promotion instead.
6. **Keep notes manageable.** Aim below about 200 lines / 8KB per note. Split oversized notes by topic with one-line cross-links. Checkpoints may exceed the budget: trim prose, never facts.
7. **Keep maps useful.** Each writable home's MAP.md may include a Cheatsheet of rules that apply in every window; keep it short, about 5 lines. The rest stays the note index: durable notes' addresses and short gists, for lookup. Preserve standing rules, add promoted notes, and drop entries that no longer hold. Maps follow the same size budget.
8. **Preserve the record.** Never physically delete a live note; after merging, crumple the absorbed note only if it is writable. The wastebasket is the one exception: physically delete a crumpled note when its home is writable and it has been crumpled and untouched for more than 7 days. With raw frontmatter, judge by `lastAccessed`, falling back to `crumpledAt`. With only `notes_*` tools, judge by `crumpled_at`. If no date is readable, keep the note and report it. Never read a raw note through `notes_read` to get the date: it refreshes `lastAccessed`. A venue that cannot delete files lists the doomed addresses in its report instead of blanking them. Preserve existing metadata and provenance.

## Report

Give a concise report grouped by home: what you inspected, changed, promoted, deleted, and left unresolved. Mention coverage gaps and partial failures. If no notes changed, say so. Distinguish actual note changes from execution or audit artifacts; do not claim success for an incomplete run.

Put skill ideas and unresolved questions in the final message as proposals for the human, not new skill files.
