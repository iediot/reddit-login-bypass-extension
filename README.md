<div align="center">

<img width="128" height="128" alt="Reddit Login Bypass" src="assets/logo.png" />

# Reddit Login Bypass

**A Safari extension that clears Reddit's login wall out of the way, automatically**

![JavaScript](https://img.shields.io/badge/JavaScript-F7DF1E?style=flat-sqircle&logo=javascript&logoColor=black)
![Safari](https://img.shields.io/badge/Safari-006CFF?style=flat-sqircle&logo=safari&logoColor=white)
![macOS](https://img.shields.io/badge/macOS-000000?style=flat-sqircle&logo=apple&logoColor=white)
![iOS](https://img.shields.io/badge/iOS-000000?style=flat-sqircle&logo=apple&logoColor=white)

</div>

---

## Why

Reddit recently implemented a login requirement just for surfing their website. Every page 
either kicks you out or spams you with pop-ups to log in or look at their AI-suggested similar 
posts. You just came for one comment thread to get your information and get on with your day, 
but they block you before you can even get to the second reply.

Blocklist extensions handle this with a list of CSS selectors, which is a losing position:
Reddit rewrites its frontend constantly, and every rewrite silently breaks the list. This one
matches on what the wall *does* and *says* instead of what it's called — two toggles, on by
default:

| Rule | What it removes |
|---|---|
| **Login prompts** | The wall over the page and the panel beside it, plus the scroll lock and the blur they add |
| **People also ask about** | The generated question block on search results |

The login you open yourself by pressing **Log In** is never touched — hiding that would break
signing in.

Anything a rule misses can be pointed at directly: **Pick element** highlights whatever is under
the cursor, `⇧`/`↑` and `↓` widen and narrow the selection, `⌥` reaches behind whatever is on
top, and a click hides it on every later visit. Picking stays on until `Esc` or a right-click,
and `⌃⇧H` toggles it without the popup. On touch there is no hover, no right-click and no
keyboard, so the same moves become a control bar: tap to select, then **Wider**, **Narrower**,
**Hide**, **Done**. Same idea as Safari's own Hide Distracting Items, and the escape hatch for
whatever Reddit ships next.

## How it works

The content script runs at `document_start` on `reddit.com`, sweeps on every DOM mutation and
route change, and hides (never removes) what it finds, tagging each element so a toggle can
put it straight back.

Finding the wall is the hard part, because it hides from all the obvious tests — it has appeared
as a fixed layer, as a modal `<dialog>` in the top layer, as a 0×0 shadow host, and as a panel in
the layout, sometimes two of those at once. Five passes run together, and any one of them is
enough:

    obstructing layer   fixed/sticky, covers the viewport, swallows clicks
    known containers    #desktop-dynamic-upsell-dialog and the rpl-modal-card riding with it
    copy signature      "join the most real place on the internet", "continue with apple", …
    topmost overlay     whatever is topmost mid-screen and is not part of the page
    rail prompts        a narrow column of login copy that sits in the layout

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

Two more details decide whether the wall actually goes away. The backdrop and the card are
**separate sibling elements**, so hiding one leaves the other on screen. And a modal `<dialog>`
lives in the **top layer**: it keeps painting, `::backdrop` included, even with an ancestor set
to `display: none`, so it has to be *closed* rather than hidden.

Expansion is where the guards live. A hit is usually an inner fragment — a heading, a button —
so it climbs to the outermost enclosing block, stopping at page content, at real material (posts,
comments, community links), or at 75% of the viewport. Post media is never touched by an
automatic rule. The page's own content is never a candidate.

Picks are stored as a **selector path**, one selector per shadow level, resolved hop by hop:

```json
["shreddit-app", "faceplate-dialog", "div.prompt > button"]
```

Hashed class names are filtered out so a path survives a rebuild, and each path records how many
elements it matched when it was stored — if it ever matches more, it has gone ambiguous and is
refused rather than hiding a whole class of elements.

## Mac and iPhone

Four targets, two products, one copy of the extension. `reddit-login-bypass Extension/Resources/`
is the whole extension — manifest, content scripts, popup — and both the macOS and the iOS
extension targets build from that same folder, so there is nothing to keep in sync.

| Target | Product |
|---|---|
| `reddit-login-bypass` / `reddit-login-bypass Extension` | macOS app + `.appex` |
| `reddit-login-bypass iOS` / `reddit-login-bypass iOS Extension` | iOS app + `.appex` |

The container apps do nothing but tell you how to switch the extension on — that is simply how
Safari extensions are distributed. On macOS the app can read whether the extension is enabled and
open Safari's settings for you; iOS has no API for either, so its app only shows the steps.

**iOS has no unsigned path.** macOS has *Allow Unsigned Extensions*, which is what makes the
`.app.zip` in Releases work. iOS has no equivalent, so the iOS build has to be signed: sideloaded
from Xcode with a free Apple ID (re-signed every 7 days), or shipped through TestFlight or the
App Store with a paid Developer Program membership.
