//
//  content.js
//  Runs automatically on reddit.com. Each cleanup is a rule that can be
//  switched off from the toolbar popup.
//
//  Detection is driven by text, ARIA roles and geometry rather than Reddit's
//  class names, and every query goes through deep-dom.js so it reaches inside
//  the shadow roots Reddit renders its UI into. Elements are hidden, never
//  detached, and tagged with a marker attribute, so switching a rule off puts
//  them straight back.
//
//  Anything the rules miss can be pointed at directly with the picker, which
//  stores a selector path and re-applies it on every visit.
//

(() => {
    "use strict";

    const api = globalThis.browser ?? globalThis.chrome;
    const dom = globalThis.__redditBypassDom;
    const STATE_KEY = "__redditLoginBypass__";

    // Bumped whenever the message protocol or rules change. A tab loaded before
    // a rebuild keeps running the old script; re-injecting used to hit the
    // guard below and return, leaving the old build to answer messages it does
    // not understand — which is what produced the "older version" nag on tabs
    // that had just been reloaded.
    const VERSION = 10;

    if (!dom) return console.error("[reddit-bypass] deep-dom.js did not load");

    const existing = globalThis[STATE_KEY];
    if (existing?.version === VERSION) return existing.sweep("re-injected");
    // An older build is running here: stand it down and take over.
    if (existing) {
        try { existing.disarm(); existing.stopPicker?.(); } catch {}
    }

    const {
        deepQueryAll, deepElementFromPoint, parentOf, deepText, deepQueryWithin,
        deepFindText, pathFor, resolvePath, invalidateRootCache,
    } = dom;

    // ---------------------------------------------------------------------
    // Tunables
    // ---------------------------------------------------------------------
    const CONFIG = {
        MIN_COVERAGE: 0.30,                 // fixed layer counts as a wall...
        MIN_COVERAGE_WITH_LOGIN_TEXT: 0.08, // ...or this, if it reads as a login prompt
        MIN_Z_INDEX: 100,                   // soft signal only
        MIN_OPACITY: 0.05,
        PROBE_POINTS: [[0.5, 0.5], [0.5, 0.28], [0.5, 0.72], [0.22, 0.5], [0.78, 0.5]],
        MAX_ANCESTOR_CLIMB: 14,
        SWEEP_THROTTLE_MS: 150,
        LEFT_RAIL_MAX_X: 0.45,              // fraction of viewport width
    };

    const DEFAULTS = {
        loginWall: true,
        sidebarLoginPrompt: true,
        peopleAlsoAsk: true,
        customRules: [],
        debug: false,
    };

    const MARK_ATTR = "data-reddit-bypass-hidden";
    const KEEP_ATTR = "data-reddit-bypass-keep";
    const STYLE_ID = "reddit-login-bypass-unlock";
    const PICKER_ID = "reddit-bypass-picker";

    // Broad gate: does this block read as a login prompt at all?
    const LOGIN_TEXT_RE =
        /(\blog ?in\b|\bsign ?in\b|\bsign ?up\b|create (a |an )?account|already have an account|continue with |sign in with |join reddit|join the most real place|\bget started\b|reddit is better when|already a redditor)/i;

    // Tight gate for buttons and links in the left rail, where "get started"
    // and the like would be too eager.
    const LOGIN_ACTION_RE =
        /(\blog ?in\b|\bsign ?in\b|\bsign ?up\b|create (a |an )?account|already have an account|continue with |sign in with )/i;

    // Phrases specific enough to identify a prompt on their own, wherever it
    // sits and whatever it is built from. Reddit's markup churns; its copy
    // does not. Verified against the live wall.
    const LOGIN_SIGNATURE_RE =
        /(join the most real place on the internet|i already have an account|continue with (apple|google|email|phone)|sign in with apple|reddit is better when|already a redditor)/i;

    const PEOPLE_ALSO_ASK_RE = /people also ask/i;

    const CONTENT_ROOT_SELECTOR = [
        "main", "#main-content", '[role="main"]', "shreddit-app",
        "#siteTable", ".content[role='main']",
    ].join(",");

    const DIALOG_SELECTOR = [
        "dialog[open]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
        "faceplate-dialog", "shreddit-signup-drawer", "shreddit-overlay-display",
        'shreddit-async-loader[bundlename*="login"]',
        'shreddit-async-loader[bundlename*="signup"]',
        'shreddit-async-loader[bundlename*="drawer"]',
    ].join(",");

    const CLICKABLE_SELECTOR = [
        'a[href*="/login"]', 'a[href*="/register"]', "button", '[role="button"]',
        "faceplate-tracker", '[data-testid*="login" i]', '[data-testid*="signup" i]',
    ].join(",");

    const PEOPLE_ALSO_ASK_SELECTOR = [
        '[data-testid*="people-also-ask" i]', '[aria-label*="people also ask" i]',
        "shreddit-related-questions",
    ].join(",");

    let settings = { ...DEFAULTS };
    const log = (...args) => { if (settings.debug) console.log("[reddit-bypass]", ...args); };

    // ---------------------------------------------------------------------
    // Geometry / visibility
    // ---------------------------------------------------------------------

    function coverage(rect) {
        const w = window.innerWidth, h = window.innerHeight;
        if (w <= 0 || h <= 0) return 0;
        const cw = Math.max(0, Math.min(rect.right, w) - Math.max(rect.left, 0));
        const ch = Math.max(0, Math.min(rect.bottom, h) - Math.max(rect.top, 0));
        return (cw * ch) / (w * h);
    }

    function unionRect(a, b) {
        if (!a) return b;
        if (!b) return a;
        const left = Math.min(a.left, b.left);
        const top = Math.min(a.top, b.top);
        return new DOMRect(left, top,
            Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
    }

    // What an element actually paints, which is not always what its own border
    // box says. A shadow host whose children are all position:fixed measures
    // 0×0 — Reddit's login wall is exactly that: a 0×0 div rendering a
    // full-screen prompt. Measuring only the host's own rect made every rule
    // discard it as invisible, while hiding the host still removes the wall.
    function effectiveRect(el, depth = 4) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return rect;
        if (depth <= 0) return rect;

        let box = null, seen = 0;
        for (const kid of [...(el.shadowRoot?.children ?? []), ...(el.children ?? [])]) {
            if (seen++ > 12) break;
            const kidRect = effectiveRect(kid, depth - 1);
            if (kidRect.width > 0 && kidRect.height > 0) box = unionRect(box, kidRect);
        }
        return box ?? rect;
    }

    const coverageOf = (el) => coverage(effectiveRect(el));

    // Likewise for position: the host may be static while what it renders is
    // fixed. Look a few levels in, shadow root included.
    function rendersFixedLayer(el, depth = 3) {
        const position = getComputedStyle(el).position;
        if (position === "fixed" || position === "sticky") return true;
        if (depth <= 0) return false;

        let seen = 0;
        for (const kid of [...(el.shadowRoot?.children ?? []), ...(el.children ?? [])]) {
            if (seen++ > 12) break;
            if (rendersFixedLayer(kid, depth - 1)) return true;
        }
        return false;
    }

    // NOTE: `offsetParent !== null` is useless here — it is null for every
    // position:fixed element, which is exactly what we are looking for.
    function isVisible(el) {
        if (!(el instanceof Element) || !el.isConnected) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
        if (parseFloat(cs.opacity) <= CONFIG.MIN_OPACITY) return false;
        // Measured through effectiveRect, so a zero-box host that renders a
        // full-screen layer counts as visible. checkVisibility() is deliberately
        // not used: it answers for the element's own box, not for what it paints.
        const rect = effectiveRect(el);
        return rect.width > 0 && rect.height > 0;
    }

    function resolvedZIndex(el) {
        let node = el, best = 0, depth = 0;
        while (node && node !== document.documentElement && depth++ < CONFIG.MAX_ANCESTOR_CLIMB) {
            const z = parseInt(getComputedStyle(node).zIndex, 10);
            if (!Number.isNaN(z) && z > best) best = z;
            node = parentOf(node);
        }
        return best;
    }

    function containsPageContent(el) {
        if (el === document.body || el === document.documentElement) return true;
        for (const root of document.querySelectorAll(CONTENT_ROOT_SELECTOR)) {
            if (el === root || el.contains(root)) return true;
        }
        return false;
    }

    // The opposite question: is this element part of the page rather than
    // something covering it?
    function isInsidePageContent(el) {
        for (const root of document.querySelectorAll(CONTENT_ROOT_SELECTOR)) {
            if (root.contains(el)) return true;
        }
        return false;
    }

    function looksLikeLoginPrompt(el) {
        if (deepQueryWithin(el, 'a[href*="/login"], a[href*="/register"]')) return true;
        return LOGIN_TEXT_RE.test(deepText(el));
    }

    // The guard: a rail block listing communities is not a login prompt, even
    // if a "log in" link happens to sit inside it.
    function listsCommunities(el) {
        const links = el.querySelectorAll?.('a[href*="/r/"], a[href*="/user/"]') ?? [];
        if (links.length >= 2) return true;
        const shadowLinks = el.shadowRoot?.querySelectorAll('a[href*="/r/"], a[href*="/user/"]') ?? [];
        return shadowLinks.length >= 2;
    }

    // Post media is never a login prompt. Automatic rules refuse to touch it,
    // so a misfiring heuristic can never eat the picture you were looking at.
    const POST_SELECTOR =
        "shreddit-post, article, [data-testid='post-container'], [slot*='post-media'], [slot='post-image']";

    function isPostMedia(el) {
        if (/^(img|video|picture|source|canvas|figure)$/i.test(el.tagName)) return true;
        return !!el.closest?.(POST_SELECTOR);
    }

    // Real page material: posts, comments, community or user links. A prompt
    // holds none of it — only its own copy and a couple of policy links — so
    // this is what tells an expanding selection where the prompt ends.
    function containsFeedContent(el) {
        if (listsCommunities(el)) return true;
        if (el.querySelector?.("shreddit-post, article, [data-testid='post-container']")) return true;
        const links = el.querySelectorAll?.('a[href*="/comments/"]') ?? [];
        return links.length >= 2;
    }

    const outermost = (elements) => {
        const all = [...new Set(elements)];
        return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
    };

    // A hit is usually an inner piece — the buttons inside a banner, a heading
    // inside a modal — while the container itself is neither fixed nor large
    // enough to qualify on its own. Climb to the outermost ancestor that is
    // still nothing but prompt.
    //
    // The stopping conditions are structural, not textual: an earlier
    // text-growth cap stopped one level up and left the rest of the prompt on
    // screen, which is why hiding one by hand took several clicks.
    function expandToPrompt(el) {
        let node = el, best = el, depth = 0;

        while (node && depth++ < CONFIG.MAX_ANCESTOR_CLIMB) {
            const parent = parentOf(node);
            if (!parent || parent === document.body || parent === document.documentElement) break;
            if (parent.hasAttribute?.(MARK_ATTR)) break;
            if (containsPageContent(parent)) break;   // reached the page itself
            if (containsFeedContent(parent)) break;   // reached real content
            if (coverageOf(parent) > 0.75) break;
            best = parent;
            node = parent;
        }
        return best;
    }

    // ---------------------------------------------------------------------
    // Rule 1 — the full-screen login wall
    // ---------------------------------------------------------------------

    function isObstructingLayer(el) {
        if (!(el instanceof Element)) return false;
        if (el === document.body || el === document.documentElement) return false;
        if (el.hasAttribute(MARK_ATTR) || el.id === STYLE_ID || el.id === PICKER_ID) return false;

        const cs = getComputedStyle(el);
        // The host may be static while what it renders inside is fixed.
        if (!rendersFixedLayer(el)) return false;
        if (cs.pointerEvents === "none") return false; // clicks pass through: harmless
        if (!isVisible(el)) return false;
        if (containsPageContent(el)) return false;

        const cover = coverageOf(el);
        const isPrompt = looksLikeLoginPrompt(el);
        if (cover < (isPrompt ? CONFIG.MIN_COVERAGE_WITH_LOGIN_TEXT : CONFIG.MIN_COVERAGE)) return false;
        // z-index is a soft signal — a top-layer <dialog> reports z-index auto.
        return isPrompt || resolvedZIndex(el) >= CONFIG.MIN_Z_INDEX;
    }

    // Seed from whatever is genuinely topmost at each probe point — inside
    // shadow roots included — then climb.
    function probeLayers() {
        const seen = new Set(), hits = [];
        for (const [fx, fy] of CONFIG.PROBE_POINTS) {
            let node = deepElementFromPoint(window.innerWidth * fx, window.innerHeight * fy);
            let depth = 0;
            while (node && depth++ < CONFIG.MAX_ANCESTOR_CLIMB) {
                if (node === document.body || node === document.documentElement) break;
                if (!seen.has(node)) {
                    seen.add(node);
                    if (isObstructingLayer(node)) hits.push(node);
                }
                node = parentOf(node);
            }
        }
        return hits;
    }

    // Copy-driven pass: find the prompt's own words anywhere on the page, then
    // expand to the block that owns them. This does not care whether the thing
    // is fixed, a dialog, in the top layer, in a shadow root, or just a panel
    // sitting in the right rail — which is what the geometry passes kept
    // missing.
    function findByLoginSignature() {
        const hits = [];
        for (const el of deepFindText(LOGIN_SIGNATURE_RE)) {
            if (containsPageContent(el)) continue;
            const block = expandToPrompt(el);
            if (!isVisible(block)) continue;
            if (containsPageContent(block) || containsFeedContent(block)) continue;
            hits.push(block);
        }
        return hits;
    }

    // Last resort, and the one that survives a closed shadow root: whatever is
    // topmost in the middle of the viewport and is not part of the page is, by
    // definition, covering it. This deliberately uses the light-DOM
    // elementsFromPoint, which retargets to the shadow host — the host is all
    // we can see or hide when the root is closed, and it is also the only thing
    // the picker can reach, which is why picking works here and the text and
    // geometry passes do not.
    function findTopmostOverlayHost() {
        // Without a content root there is no way to tell an overlay from the
        // page itself, and hiding the wrong one would take the whole page.
        if (!document.querySelector(CONTENT_ROOT_SELECTOR)) return [];

        const hits = [];
        for (const [fx, fy] of CONFIG.PROBE_POINTS) {
            const top = document.elementsFromPoint(window.innerWidth * fx, window.innerHeight * fy)[0];
            if (!top || top === document.body || top === document.documentElement) continue;
            if (isInsidePageContent(top)) continue;    // ordinary page under the cursor
            if (top.hasAttribute(MARK_ATTR) || top.id === PICKER_ID) continue;

            const block = expandToPrompt(top);
            if (!isVisible(block)) continue;
            if (containsPageContent(block) || containsFeedContent(block)) continue;

            // Either it covers a real part of the screen, or it says what it is.
            const cover = coverageOf(block);
            if (cover < 0.12 && !looksLikeLoginPrompt(block)) continue;
            hits.push(block);
        }
        return hits;
    }

    function findLoginWall() {
        const hits = probeLayers();

        // A modal <dialog> is the likely shape: its box may be small and its
        // backdrop is a pseudo-element, so coverage alone never catches it.
        for (const dialog of deepQueryAll(DIALOG_SELECTOR)) {
            if (!isVisible(dialog)) continue;
            if (containsPageContent(dialog)) continue;
            if (!looksLikeLoginPrompt(dialog)) continue;
            hits.push(dialog);
        }

        return outermost([
            ...hits.map(expandToPrompt),
            ...findByLoginSignature(),
            ...findTopmostOverlayHost(),
        ]);
    }

    // ---------------------------------------------------------------------
    // Rule 2 — the login prompt in the left rail
    // ---------------------------------------------------------------------

    // Climb to the largest ancestor that is still a self-contained prompt card.
    function promptBlockFor(el) {
        let node = el, best = null, depth = 0;
        while (node && depth++ < CONFIG.MAX_ANCESTOR_CLIMB) {
            const parent = parentOf(node);
            if (!parent || parent === document.body || parent === document.documentElement) break;
            if (containsPageContent(parent)) break;
            if (listsCommunities(parent)) break; // ← communities list, leave alone
            const rect = parent.getBoundingClientRect();
            if (rect.width > window.innerWidth * CONFIG.LEFT_RAIL_MAX_X) break;
            if (rect.height > window.innerHeight * 0.7) break;
            best = parent;
            node = parent;
        }
        return best;
    }

    function findSidebarLoginPrompt() {
        const hits = [];
        // Not just anchors: the rail's prompt is often a <button> or a
        // <faceplate-tracker> that opens the modal, with no href at all.
        for (const el of deepQueryAll(CLICKABLE_SELECTOR)) {
            if (!isVisible(el)) continue;
            if (!LOGIN_ACTION_RE.test(deepText(el, 200))) continue;

            const rect = el.getBoundingClientRect();
            // Left rail only — this must never touch the header's log-in button.
            if (rect.left > window.innerWidth * CONFIG.LEFT_RAIL_MAX_X) continue;
            if (rect.top < 0) continue;

            const block = promptBlockFor(el);
            if (!block || block === el) continue;
            if (listsCommunities(block)) continue;
            if (!looksLikeLoginPrompt(block)) continue;
            hits.push(block);
        }
        return outermost(hits);
    }

    // ---------------------------------------------------------------------
    // Rule 3 — "People also ask about" on search results
    // ---------------------------------------------------------------------

    function findPeopleAlsoAsk() {
        const hits = [];

        for (const el of deepQueryAll(PEOPLE_ALSO_ASK_SELECTOR)) {
            if (isVisible(el) && !containsPageContent(el)) hits.push(el);
        }

        for (const heading of deepQueryAll('h1,h2,h3,h4,h5,[role="heading"],summary,legend')) {
            if (!PEOPLE_ALSO_ASK_RE.test(heading.textContent || "")) continue;
            // Climb to the section that owns the heading, stopping before we
            // reach anything that also holds real results.
            let node = heading, best = heading, depth = 0;
            while (node && depth++ < CONFIG.MAX_ANCESTOR_CLIMB) {
                const parent = parentOf(node);
                if (!parent || parent === document.body || parent === document.documentElement) break;
                if (containsPageContent(parent)) break;
                if (coverageOf(parent) > 0.6) break;
                best = parent;
                node = parent;
            }
            if (best !== heading && isVisible(best)) hits.push(best);
        }

        return outermost(hits);
    }

    // ---------------------------------------------------------------------
    // Rule 4 — elements picked by hand
    // ---------------------------------------------------------------------

    // Which pick hid which element. Marking every pick with the same "custom"
    // tag meant an element could not be traced back to the rule that hid it, so
    // removing that rule left it hidden with nothing pointing at it.
    const hiddenBy = new WeakMap();

    function findCustom() {
        const hits = [];
        for (const rule of settings.customRules ?? []) {
            const found = resolvePath(rule.path);

            // A path that now matches more than it did when it was stored has
            // gone ambiguous — the page was rebuilt around it and the selector
            // caught a whole class of elements. One accidental pick then hides
            // every post image on the page. Refuse to apply it.
            if (rule.count && found.length > rule.count) {
                log("skipping ambiguous pick", rule.label, `${found.length} matches, stored ${rule.count}`);
                continue;
            }

            for (const el of found) {
                if (el.hasAttribute(MARK_ATTR)) continue;
                if (containsPageContent(el)) continue; // never let a stale path eat the page
                hiddenBy.set(el, rule.id);
                hits.push(el);
            }
        }
        return hits;
    }

    const customMark = (el) => `custom:${hiddenBy.get(el) ?? "unknown"}`;

    // ---------------------------------------------------------------------
    // Hiding / restoring / scroll unlock
    // ---------------------------------------------------------------------

    // Every element we hide, held directly. Restoring used to depend on finding
    // them again by walking the DOM, which can miss a deep shadow root once the
    // traversal budget runs out — and a missed element can never be brought
    // back by any button. This set does not depend on traversal at all.
    const hiddenElements = new Set();

    function hiddenMatching(predicate) {
        const out = new Set();
        for (const el of hiddenElements) {
            if (el.isConnected && el.hasAttribute(MARK_ATTR) && predicate(el)) out.add(el);
            else if (!el.isConnected) hiddenElements.delete(el);
        }
        // DOM sweep as a backstop, for anything hidden by an earlier session.
        for (const el of deepQueryAll(`[${MARK_ATTR}]`)) {
            if (predicate(el)) out.add(el);
        }
        return [...out];
    }

    function hide(el, ruleId) {
        // Something the user put back stays back, whatever the rules think.
        if (el.hasAttribute(KEEP_ATTR)) return;
        // Top-layer dialogs: close() also drops the ::backdrop, which no amount
        // of display:none on other nodes can reach.
        if (el.tagName === "DIALOG" && el.open) { try { el.close(); } catch {} }
        if (typeof el.hidePopover === "function" && el.matches?.(":popover-open")) {
            try { el.hidePopover(); } catch {}
        }
        el.setAttribute(MARK_ATTR, ruleId === "custom" ? customMark(el) : ruleId);
        el.style.setProperty("display", "none", "important");
        hiddenElements.add(el);
        log("hid", ruleId, el.tagName.toLowerCase(), el.className || "");
    }

    function unhide(el, { keep = false } = {}) {
        el.style.removeProperty("display");
        el.removeAttribute(MARK_ATTR);
        hiddenElements.delete(el);
        if (keep) el.setAttribute(KEEP_ATTR, "1");
    }

    function restore(ruleId) {
        // Picks are tagged custom:<rule id>, so "custom" means all of them.
        const matches = hiddenMatching((el) => {
            if (!ruleId) return true;
            const mark = el.getAttribute(MARK_ATTR) ?? "";
            return ruleId === "custom" ? mark.startsWith("custom") : mark === ruleId;
        });
        for (const el of matches) unhide(el);
        if (!ruleId || ruleId === "loginWall") {
            document.getElementById(STYLE_ID)?.remove();
            document.documentElement.style.removeProperty("overflow");
            document.body?.style.removeProperty("overflow");
            document.body?.style.removeProperty("position");
        }
    }

    function unlockScroll() {
        const html = document.documentElement;
        const body = document.body;

        // Locks that stash the offset in `body { position: fixed; top: -Npx }`.
        let restoreY = null;
        if (body) {
            const cs = getComputedStyle(body);
            if (cs.position === "fixed") {
                const top = parseFloat(cs.top);
                if (!Number.isNaN(top) && top < 0) restoreY = -top;
            }
        }

        for (const el of [html, body]) {
            if (!el) continue;
            for (const prop of ["overflow", "overflow-x", "overflow-y", "position", "top",
                                "height", "max-height", "padding-right", "touch-action",
                                "overscroll-behavior", "filter"]) {
                el.style.removeProperty(prop);
            }
            for (const cls of [...el.classList]) {
                if (/(^|[-_])(scroll[-_]?lock(ed)?|no[-_]?scroll|overflow[-_]?hidden|modal[-_]?open|prevent[-_]?scroll|is[-_]?locked)($|[-_])/i.test(cls)) {
                    el.classList.remove(cls);
                }
            }
            for (const attr of ["data-scroll-locked", "data-lock-scroll", "data-scroll-lock",
                                "data-modal-open", "scroll-lock"]) {
                el.removeAttribute(attr);
            }
        }

        // Inline and !important, because a page CSP can refuse the stylesheet
        // below. These are removed again if the rule is switched off.
        html?.style.setProperty("overflow", "auto", "important");
        if (body) {
            body.style.setProperty("overflow", "visible", "important");
            body.style.setProperty("position", "static", "important");
        }

        if (!document.getElementById(STYLE_ID)) {
            const style = document.createElement("style");
            style.id = STYLE_ID;
            style.textContent = `
                html { overflow: auto !important; overscroll-behavior: auto !important; }
                body {
                    overflow: visible !important;
                    position: static !important;
                    height: auto !important;
                    max-height: none !important;
                    touch-action: auto !important;
                }
                /* The wall usually blurs the content behind it. */
                html, body, main, shreddit-app { filter: none !important; }
            `;
            (document.head || document.documentElement).appendChild(style);
        }

        if (restoreY !== null) window.scrollTo(0, restoreY);
    }

    // ---------------------------------------------------------------------
    // Sweep
    // ---------------------------------------------------------------------

    const RULES = [
        { id: "loginWall", find: findLoginWall, unlocks: true },
        { id: "sidebarLoginPrompt", find: findSidebarLoginPrompt, unlocks: false },
        { id: "peopleAlsoAsk", find: findPeopleAlsoAsk, unlocks: false },
        { id: "custom", find: findCustom, unlocks: false, always: true },
    ];

    const counts = { loginWall: 0, sidebarLoginPrompt: 0, peopleAlsoAsk: 0, custom: 0 };
    let lastSweepAt = 0, scheduled = false, lastHref = location.href, observer = null;

    function sweep(reason) {
        lastSweepAt = Date.now();
        const hidden = {};
        for (const rule of RULES) {
            if (!rule.always && !settings[rule.id]) continue;
            let found = [];
            try {
                found = rule.find();
            } catch (err) {
                console.error(`[reddit-bypass] rule ${rule.id} failed:`, err);
                continue;
            }
            // Anything the user put back is off limits, and must not be
            // counted. Automatic rules additionally never take post media.
            const fresh = found.filter((el) =>
                !el.hasAttribute(KEEP_ATTR) && (rule.id === "custom" || !isPostMedia(el)));
            for (const el of fresh) hide(el, rule.id);
            if (fresh.length) {
                hidden[rule.id] = fresh.length;
                counts[rule.id] += fresh.length;
                if (rule.unlocks) unlockScroll();
            }
        }
        // The wall can lock scrolling before we manage to hide it.
        if (settings.loginWall && document.body && getComputedStyle(document.body).overflow === "hidden") {
            unlockScroll();
        }
        if (Object.keys(hidden).length) log("sweep", reason, hidden);
        return { ok: true, hidden, totals: { ...counts } };
    }

    function scheduleSweep(reason) {
        if (scheduled) return;
        scheduled = true;
        const wait = Math.max(0, CONFIG.SWEEP_THROTTLE_MS - (Date.now() - lastSweepAt));
        setTimeout(() => {
            scheduled = false;
            requestAnimationFrame(() => sweep(reason));
        }, wait);
    }

    function arm() {
        observer?.disconnect();
        observer = new MutationObserver((records) => {
            if (location.href !== lastHref) {
                lastHref = location.href;
                invalidateRootCache();
                scheduleSweep("route change");
                return;
            }
            for (const record of records) {
                for (const node of record.addedNodes) {
                    if (node.nodeType === Node.ELEMENT_NODE) {
                        // New elements may bring new shadow roots with them.
                        invalidateRootCache();
                        return scheduleSweep("mutation");
                    }
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        // history.pushState cannot be patched from a content script — the
        // isolated world has its own `history`, so the page's calls never reach
        // a patch here. The href check above plus these events cover SPA nav.
        const onNav = () => {
            lastHref = location.href;
            invalidateRootCache();
            scheduleSweep("navigation");
        };
        window.addEventListener("popstate", onNav);
        window.addEventListener("hashchange", onNav);
        // The wall is often raised on scroll depth rather than on navigation.
        window.addEventListener("scroll", () => scheduleSweep("scroll"), { passive: true });

        // Ctrl+Shift+H toggles the picker without going through the popup — if
        // the toolbar button ever stops responding (a stale content script in
        // an old tab, say), this still works.
        window.addEventListener("keydown", (event) => {
            if (event.ctrlKey && event.shiftKey && (event.key === "H" || event.key === "h")) {
                event.preventDefault();
                event.stopPropagation();
                togglePicker();
            }
        }, true);
    }

    // ---------------------------------------------------------------------
    // Picker — the Hide Distracting Items approach: point at it, store a
    // selector path for it, re-apply that path on every visit.
    // ---------------------------------------------------------------------

    let picker = null;

    // Every style here is set through CSSOM rather than an injected <style>:
    // Reddit's CSP blocks stylesheets we add to the page, which would leave the
    // highlight and the hint invisible. Inline .style is not subject to it.
    const PICKER_STYLES = {
        // The reset in the middle undoes the UA styles a popover carries
        // (border, padding, background, auto margins).
        host: "position:fixed;inset:0;width:auto;height:auto;max-width:none;max-height:none;" +
              "margin:0;padding:0;border:0;background:transparent;overflow:visible;" +
              "z-index:2147483647;pointer-events:none;",
        box: "position:fixed;left:0;top:0;width:0;height:0;box-sizing:border-box;" +
             "border:2px solid #ff4500;background:rgba(255,69,0,0.18);border-radius:4px;" +
             "pointer-events:none;",
        hint: "position:fixed;left:50%;bottom:24px;top:auto;right:auto;transform:translateX(-50%);" +
              "margin:0;width:auto;height:auto;max-width:none;border:0;" +
              "background:#1c1c1e;color:#fff;font:500 13px/1.4 system-ui,-apple-system,sans-serif;" +
              "padding:8px 14px;border-radius:999px;pointer-events:none;white-space:nowrap;" +
              "box-shadow:0 4px 16px rgba(0,0,0,0.4);",
    };

    const HINT_TEXT = "Click elements to hide them  ·  ↑ wider  ·  ↓ narrower  ·  Esc to finish";

    // What a click should actually take. Hovering lands on whatever node owns
    // the pixel — a text span, an <svg> path, a wrapper that adds nothing — so
    // climb to the smallest ancestor that is a block in its own right. This is
    // what makes the highlight snap to the button, the card or the banner
    // instead of to a fragment of text.
    function snapToBlock(el) {
        let node = el, depth = 0;

        // Inside an icon: take the whole <svg> first.
        if (node instanceof SVGElement && node.ownerSVGElement) node = node.ownerSVGElement;

        while (node && depth++ < 8) {
            const parent = parentOf(node);
            if (!parent || parent === document.body || parent === document.documentElement) break;
            if (containsPageContent(parent) || containsFeedContent(parent)) break;

            const rect = node.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            const display = getComputedStyle(node).display;

            // Climb when this node is not a block of its own: inline content, a
            // box the parent merely wraps, an only child, or something too
            // small to be a meaningful target.
            const isInline = /^(inline|inline-block|inline-flex|contents|ruby)/.test(display);
            const wrappedExactly = Math.abs(rect.width - parentRect.width) <= 4 &&
                                   Math.abs(rect.height - parentRect.height) <= 4;
            const onlyChild = parent.children.length === 1;
            const tiny = rect.width < 24 || rect.height < 12;

            if (!(isInline || wrappedExactly || onlyChild || tiny)) break;
            node = parent;
        }
        return node;
    }

    function startPicker() {
        if (picker) return { ok: true, active: true, already: true };

        const host = document.createElement("div");
        host.id = PICKER_ID;
        host.style.cssText = PICKER_STYLES.host;

        const box = document.createElement("div");
        box.style.cssText = PICKER_STYLES.box;

        const hint = document.createElement("div");
        hint.style.cssText = PICKER_STYLES.hint;
        hint.textContent = HINT_TEXT;

        host.append(box, hint);
        document.documentElement.appendChild(host);
        // A login wall opened with showModal() lives in the top layer, above
        // every z-index there is. A manual popover joins that layer without
        // making the page inert, so the highlight stays on top and the page
        // stays clickable.
        raiseToTopLayer(host);

        // `hovered` is whatever the cursor is over; `target` is what will be
        // hidden, which the arrow keys walk up and down from there.
        let hovered = null;
        let target = null;
        let hiddenHere = 0;

        const paint = () => {
            if (!target?.isConnected) {
                box.style.width = "0px";
                box.style.height = "0px";
                return;
            }
            const rect = effectiveRect(target);
            box.style.left = `${rect.left}px`;
            box.style.top = `${rect.top}px`;
            box.style.width = `${rect.width}px`;
            box.style.height = `${rect.height}px`;
            // Trace the element's own shape rather than drawing a generic box.
            box.style.borderRadius = getComputedStyle(target).borderRadius || "4px";
        };

        // Say what a click will take, so an over- or under-shooting selection is
        // obvious before it happens rather than after.
        const describeTarget = () => {
            if (!target) return HINT_TEXT;
            // effectiveRect, so a zero-box host reports what it paints rather
            // than reading as "0×0".
            const rect = effectiveRect(target);
            const size = `${Math.round(rect.width)}×${Math.round(rect.height)}`;
            const label = describe(target).slice(0, 44);
            return `${label}  ·  ${size}  ·  ↑ wider  ↓ narrower  ·  Esc to finish`;
        };

        const setTarget = (el) => {
            target = el;
            paint();
            hint.textContent = describeTarget();
        };

        const onMove = (event) => {
            const el = deepElementFromPoint(event.clientX, event.clientY);
            if (!el || el === hovered || host.contains(el)) return;
            hovered = el;
            // Two steps: snapToBlock climbs out of text and icon fragments, then
            // expandToPrompt takes the whole self-contained block — the same
            // expansion the automatic rules use, so pointing anywhere inside a
            // login prompt selects the entire prompt rather than one line of it.
            setTarget(expandToPrompt(snapToBlock(el)));
        };

        // ↓ walks back toward whatever the cursor is actually over.
        const childTowardsHover = () => {
            if (!target || !hovered || target === hovered) return null;
            let node = hovered;
            while (node) {
                const parent = parentOf(node);
                if (parent === target) return node;
                if (!parent) return null;
                node = parent;
            }
            return null;
        };

        const onKey = (event) => {
            if (event.key === "Escape") {
                event.preventDefault();
                stopPicker();
                return;
            }
            if (event.key === "ArrowUp") {
                event.preventDefault();
                const parent = target && parentOf(target);
                if (parent && parent !== document.body && parent !== document.documentElement) {
                    setTarget(parent);
                }
                return;
            }
            if (event.key === "ArrowDown") {
                event.preventDefault();
                const child = childTowardsHover();
                if (child) setTarget(child);
            }
        };

        // Capture phase, so Reddit's own handlers never see any of this.
        const swallow = (event) => { event.preventDefault(); event.stopPropagation(); };

        // Picking stays on until Esc (or the popup switches it off), so a whole
        // page can be cleaned up in one go.
        const onClick = (event) => {
            swallow(event);
            const picked = target;
            if (!picked || containsPageContent(picked)) return;

            const path = pathFor(picked);
            const rule = {
                id: `custom-${Date.now()}`,
                path,
                label: describe(picked),
                // How many elements this path matched at the moment it was
                // stored. If it ever matches more, it has gone ambiguous and
                // must not be applied.
                count: Math.max(1, resolvePath(path).length),
            };
            const customRules = [...(settings.customRules ?? []), rule];
            settings.customRules = customRules;
            api.storage.local.set({ customRules });
            // Record which rule owns this element BEFORE hiding it: hide() tags
            // the element from this map, and an untagged pick reads as an
            // orphan to the storage-change handler, which would restore it
            // again the moment the pick is saved.
            hiddenBy.set(picked, rule.id);
            hide(picked, "custom");
            counts.custom++;
            hiddenHere++;
            log("picked", rule.label, rule.path);

            hint.textContent =
                `Hidden ${hiddenHere} element${hiddenHere === 1 ? "" : "s"}  ·  keep clicking  ·  Esc to finish`;

            // What was under the cursor is gone; wait for the next move.
            hovered = null;
            target = null;
            paint();
        };

        window.addEventListener("mousemove", onMove, true);
        window.addEventListener("click", onClick, true);
        window.addEventListener("mousedown", swallow, true);
        window.addEventListener("mouseup", swallow, true);
        window.addEventListener("pointerdown", swallow, true);
        window.addEventListener("keydown", onKey, true);
        window.addEventListener("scroll", paint, true);
        window.addEventListener("resize", paint, true);

        picker = { host, onMove, onClick, onKey, swallow, paint, count: () => hiddenHere };
        return { ok: true, active: true };
    }

    function stopPicker() {
        if (!picker) return { ok: true, active: false };
        const { host, onMove, onClick, onKey, swallow, paint, count } = picker;
        window.removeEventListener("mousemove", onMove, true);
        window.removeEventListener("click", onClick, true);
        window.removeEventListener("mousedown", swallow, true);
        window.removeEventListener("mouseup", swallow, true);
        window.removeEventListener("pointerdown", swallow, true);
        window.removeEventListener("keydown", onKey, true);
        window.removeEventListener("scroll", paint, true);
        window.removeEventListener("resize", paint, true);
        host.remove();
        picker = null;

        const hidden = count();
        if (hidden) toast(`Hidden ${hidden} element${hidden === 1 ? "" : "s"}`);
        return { ok: true, active: false, hidden };
    }

    function togglePicker() {
        return picker ? stopPicker() : startPicker();
    }

    function raiseToTopLayer(el) {
        try {
            el.setAttribute("popover", "manual");
            el.showPopover();
        } catch {
            // Older Safari: the z-index in the inline style is the fallback.
            el.removeAttribute("popover");
        }
    }

    // The popup is closed by the time a pick lands, so confirm on the page.
    function toast(text) {
        const el = document.createElement("div");
        el.style.cssText = PICKER_STYLES.hint;
        el.textContent = text;
        document.documentElement.appendChild(el);
        raiseToTopLayer(el);
        setTimeout(() => el.remove(), 2000);
    }

    // Stylesheet and script text lives in the DOM too, and reads as gibberish
    // in a label — fall back to the tag name when that is all there is.
    const looksLikeCode = (text) => /[{};]/.test(text) || /^[:.#@][a-z-]/i.test(text);

    function describe(el) {
        const raw = (deepText(el, 200) || "").replace(/\s+/g, " ").trim();
        const text = raw && !looksLikeCode(raw) ? raw.slice(0, 40) : "";
        const tag = el.tagName.toLowerCase();
        return text ? `${tag} — “${text}”` : tag;
    }

    // ---------------------------------------------------------------------
    // Settings + messages
    // ---------------------------------------------------------------------

    api.storage.onChanged.addListener((changes, area) => {
        if (area !== "local") return;
        for (const [key, { newValue }] of Object.entries(changes)) {
            if (!(key in settings)) continue;
            settings[key] = newValue;
            if (newValue === false) restore(key);
        }
        // A removed pick comes back immediately. This works off the rule id
        // recorded on the element, not off re-resolving selector paths: a path
        // can go stale or match more than it did when it was stored, which used
        // to leave elements hidden with nothing able to bring them back.
        if (changes.customRules) {
            const oldIds = (changes.customRules.oldValue ?? []).map((r) => r.id);
            const newIds = new Set((changes.customRules.newValue ?? []).map((r) => r.id));
            const dropped = oldIds.filter((id) => !newIds.has(id));

            const droppedMarks = new Set(dropped.map((id) => `custom:${id}`));
            // Anything tagged by a dropped rule, by an older build, or by a rule
            // that no longer exists is orphaned — put it back rather than
            // stranding it with nothing able to reach it.
            const known = new Set([...newIds].map((id) => `custom:${id}`));
            for (const el of hiddenMatching((el) => droppedMarks.has(el.getAttribute(MARK_ATTR)))) {
                // Explicitly un-picked: keep it visible, no rule may re-hide it.
                unhide(el, { keep: true });
            }
            // Tagged by a rule that no longer exists, or by an older build.
            // Restore it, but without `keep` — its provenance is unknown, so
            // the automatic rules must stay free to act on it.
            const orphans = hiddenMatching((el) => {
                const mark = el.getAttribute(MARK_ATTR) ?? "";
                return mark.startsWith("custom") && !known.has(mark);
            });
            for (const el of orphans) unhide(el);
        }
        sweep("settings changed");
    });

    api.runtime.onMessage.addListener((message) => {
        switch (message?.type) {
            case "rescan": return Promise.resolve(sweep("popup"));
            case "restoreAll": {
                // Picks only. What a toggle hid is the toggle's business, and
                // comes back by switching that toggle off — not from here.
                const picked = hiddenMatching((el) =>
                    (el.getAttribute(MARK_ATTR) ?? "").startsWith("custom"));
                // No `keep`: the automatic rules stay in charge of anything they
                // would have hidden anyway, since their toggles are still on.
                for (const el of picked) unhide(el);
                return Promise.resolve({ ok: true, restored: picked.length });
            }
            case "status":
                return Promise.resolve({ ok: true, totals: { ...counts }, picking: !!picker });
            case "pick":
                try {
                    return Promise.resolve(togglePicker());
                } catch (err) {
                    // Report it rather than failing silently — the popup is the
                    // only place this can surface.
                    console.error("[reddit-bypass] picker failed:", err);
                    return Promise.resolve({ ok: false, error: String(err?.message ?? err) });
                }
            default: return undefined;
        }
    });

    Object.defineProperty(globalThis, STATE_KEY, {
        value: {
            version: VERSION,
            sweep, restore, startPicker, stopPicker, togglePicker, config: CONFIG,
            get settings() { return settings; },
            // Console helpers for tuning:
            //   __redditLoginBypass__.find.loginWall()
            find: {
                loginWall: findLoginWall,
                sidebarLoginPrompt: findSidebarLoginPrompt,
                peopleAlsoAsk: findPeopleAlsoAsk,
                layers: probeLayers,
                signature: findByLoginSignature,
                topmost: findTopmostOverlayHost,
            },
            expandToPrompt,
            pathFor,
            disarm: () => observer?.disconnect(),
        },
        configurable: true,
    });

    api.storage.local.get(DEFAULTS).then((stored) => {
        settings = { ...DEFAULTS, ...stored };
        arm();
        sweep("initial");
        // The wall usually mounts a beat after the page, and sometimes remounts.
        for (const delay of [200, 600, 1200, 2500]) setTimeout(() => sweep(`retry@${delay}ms`), delay);
    }).catch((err) => {
        console.error("[reddit-bypass] could not read settings, using defaults:", err);
        arm();
        sweep("initial (defaults)");
    });
})();
