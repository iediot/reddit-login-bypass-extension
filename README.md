<div align="center">

<img width="128" height="128" alt="Reddit Login Bypass" src="assets/logo.png" />

# Reddit Login Bypass

**A Safari extension that clears Reddit's login wall out of the way, automatically**

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-sqircle&logo=javascript&logoColor=black)
![Safari](https://img.shields.io/badge/Safari-006CFF?style=flat-sqircle&logo=safari&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=flat-sqircle&logo=apple&logoColor=white)
![Manifest V3](https://img.shields.io/badge/Manifest-V3-4285F4?style=flat-sqircle&logo=googlechrome&logoColor=white)

</div>

---

## Why

Reddit recently implemented a login requirement just for surfing their website. Every page 
either kicks you out or spams you with pop-ups to log in or look at their AI-suggested similar 
posts. You just came for one comment thread to get your information and get on with your day, 
but they block you before you can even get to the second reply.

Blocklist extensions handle this with a list of CSS selectors, which is a losing position:
Reddit rewrites its frontend constantly, and every rewrite silently breaks the list. This one
matches on what the wall *does* and *says* instead of what it's called — three toggles, on by
default:

| Rule | What it removes |
|---|---|
| **Login wall** | The prompt covering the page, plus the scroll lock and the blur behind it |
| **Sidebar login prompt** | The left-rail prompt — never the block listing your communities |
| **People also ask about** | The generated question block on search results |

Anything a rule misses can be pointed at directly: **Pick element** highlights whatever is under
the cursor, `↑`/`↓` widen and narrow the selection, and a click hides it on every later visit.
Same idea as Safari's own Hide Distracting Items, and the escape hatch for whatever Reddit ships
next.

## How it works

The content script runs at `document_start` on `reddit.com`, sweeps on every DOM mutation and
route change, and hides — never removes — what it finds, tagging each element so a toggle can
put it straight back.

Finding the wall is the hard part, because it hides from all the obvious tests. Four passes run
in parallel, and any one of them is enough:

    topmost layer   fixed/sticky, covers the viewport, swallows clicks
    dialogs         <dialog>, [aria-modal], faceplate-dialog, gated on login text
    copy signature  "join the most real place on the internet", "continue with apple", …
    overlay host    whatever is topmost mid-screen and is not part of the page

Three things make those passes work where a selector list doesn't:

- **Shadow roots.** Reddit renders its UI inside `<shreddit-*>` and `<faceplate-*>` custom
  elements. `document.querySelectorAll` cannot see in, and `elementsFromPoint` retargets to the
  outermost host, so every query goes through a shadow-piercing layer instead.
- **Zero-box hosts.** The wall's host element measures **0×0** — everything it paints is
  `position: fixed` inside its shadow root. Measuring the host's own rect makes it look invisible
  and cover nothing, so elements are measured by what they *paint*: the union of their children's
  rects, shadow root included.
- **Copy outlives markup.** Class names change every rebuild; "I already have an account" does
  not. A text pass finds the prompt's own words and expands to the block that owns them.

Expansion is where the guards live. A hit is usually an inner fragment — a heading, a button —
so it climbs to the outermost enclosing block, stopping at page content, at real material (posts,
comments, community links), or at 75% of the viewport. Post media is never touched by an
automatic rule. The page's own content is never a candidate.

Picks are stored as a **selector path**, one selector per shadow level, resolved hop by hop:

```
["shreddit-app", "faceplate-dialog", "div.prompt > button"]
```

Hashed class names are filtered out so a path survives a rebuild, and each path records how many
elements it matched when it was stored — if it ever matches more, it has gone ambiguous and is
refused rather than hiding a whole class of elements.

## Build

Open `reddit-login-bypass.xcodeproj` in Xcode and run. Then in Safari:

1. **Settings ▸ Developer ▸ Allow Unsigned Extensions**
2. **Settings ▸ Extensions** — enable it, and allow it on `reddit.com`

Reload any Reddit tab that was already open.

## Layout

| Path | What |
|---|---|
| `Resources/content.js` | Rules, guards, scroll unlock, picker |
| `Resources/deep-dom.js` | Shadow-piercing queries, hit-testing, selector paths |
| `Resources/popup.*` | Toggles, Pick element, Clear picks |
| `debug/inspect-overlay.js` | Console recon: what each pass sees on the current page |

Permissions are `storage` and `scripting`, with host access limited to `reddit.com`. Nothing
leaves the browser.
