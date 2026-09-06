# Word pairs

This file (`word-pairs.json`, next to this README) is the list of word pairs
the game shows at each fork. It's meant to be edited directly — by a
developer or a teacher — without touching any code.

## Format

```json
{
  "pairs": [
    { "id": "sheep-ship", "words": ["Sheep", "Ship"] },
    { "id": "heat-hit", "words": ["Heat", "Hit"] }
  ]
}
```

- **`pairs`** is a list. Each entry is one pair the game might use at a fork.
- **`words`** must have **exactly two** words — never one, never three. The
  two words in a pair are always shown and chosen together; they're never
  split up or mixed with a word from a different pair.
- **`id`** is a short, unique label for your own reference (lowercase,
  words separated by hyphens is the convention used so far — e.g.
  `"heat-hit"`). It isn't shown to players. It just needs to be unique across
  the whole file.

## Adding a pair

Copy an existing line, change the `id` and the two `words`, and add a comma
after the line above it if it wasn't already the last one. For example, to
add "Coat" / "Cot":

```json
    { "id": "here-hair", "words": ["Here", "Hair"] },
    { "id": "coat-cot", "words": ["Coat", "Cot"] }
```

(Note the comma added to the end of the "here-hair" line, and none on the
new last line.)

## Rules the game enforces

If a pair doesn't follow these, the game will refuse to start and say why
(check the browser console) rather than silently showing something broken:

- `words` must be an array of exactly 2 items.
- Both words must be non-empty text, and different from each other.
- Every `id` must be unique in the file.

## How pairs are picked during a round

Each round, the game randomly picks one pair per fork, without repeating a
pair within that same round (as long as there are at least as many pairs in
this file as there are forks — currently 6). Which of the two words lands on
the left vs. the right is also random and independent of which word is
"correct" for that fork.
