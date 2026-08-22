// content.js — hides Reddit's login prompts, judged by behaviour and copy.

(() => {
    "use strict";

    const api = globalThis.browser ?? globalThis.chrome;
    const dom = globalThis.__redditLoginBypassDom;

    const STATE_KEY = "__redditLoginBypass__";
    const LOG_PREFIX = "[reddit-login-bypass]";

    // Bumped with the rules, so a newer injection can take over a stale tab.
    const VERSION = 25;

    if (!dom) return console.error(LOG_PREFIX, "deep-dom.js did not load");

    // Reddit only: elsewhere the rules read a page's own fixed layout as an overlay.
    const ON_REDDIT = /(^|\.)reddit\.com$/i.test(location.hostname);

    const previous = globalThis[STATE_KEY];
    if (previous) {
        if (previous.version === VERSION && ON_REDDIT) return previous.sweep("re-injected");
        // Otherwise its observer and listeners would run alongside ours.
        try { (previous.teardown ?? previous.disarm)?.call(previous); } catch {}
    }

    if (!ON_REDDIT) {
        // Put back anything a build without the check above hid here.
        try { previous?.restore?.(); } catch {}
        delete globalThis[STATE_KEY];
        return;
    }

    const {
        deepQueryAll, deepQueryWithin, deepFindText, deepText,
        deepElementFromPoint, parentOf, pathFor, resolvePath, invalidateRootCache,
    } = dom;

    // --- Configuration ---

    const CONFIG = {
        MIN_COVERAGE: 0.30,
        // Lower bar when the copy also reads as a login prompt.
        MIN_COVERAGE_WITH_LOGIN_TEXT: 0.08,
        // Soft signal: a top-layer <dialog> reports no z-index at all.
        MIN_Z_INDEX: 100,
        MIN_OPACITY: 0.05,
        // Where to ask "what is on top here?", as viewport fractions.
        PROBE_POINTS: [[0.5, 0.5], [0.5, 0.28], [0.5, 0.72], [0.22, 0.5], [0.78, 0.5]],
        MAX_ANCESTOR_CLIMB: 14,
        SWEEP_THROTTLE_MS: 150,
        // Sanity bounds for a rail; the content guards do the real work.
        RAIL_MAX_WIDTH: 0.60,
        RAIL_MIN_HEIGHT: 60,
        // How far to look inside an element for what it actually paints.
        MEASURE_DEPTH: 8,
        MEASURE_BREADTH: 12,
    };

    const DEFAULTS = {
        loginPrompts: true,
        peopleAlsoAsk: true,
        customRules: [],
        debug: false,
    };

    // The merged toggle used to be two, and its key was `loginWall`.
    const LEGACY_TOGGLE_KEY = "loginWall";

    const MARK_ATTR = "data-reddit-login-bypass-hidden";
    const KEEP_ATTR = "data-reddit-login-bypass-keep";
    const STYLE_ID = "reddit-login-bypass-unlock";
    const PICKER_ID = "reddit-login-bypass-picker";

    let settings = { ...DEFAULTS };

    const log = (...args) => { if (settings.debug) console.log(LOG_PREFIX, ...args); };
    const warn = (...args) => console.warn(LOG_PREFIX, ...args);
    const fail = (...args) => console.error(LOG_PREFIX, ...args);

    // --- What things look like ---

    // Broad: does this block read as a login prompt at all?
    const LOGIN_TEXT_RE =
        /(\blog ?in\b|\bsign ?in\b|\bsign ?up\b|create (a |an )?account|already have an account|continue with |sign in with |join reddit|join the most real place|\bget started\b|reddit is better when|already a redditor)/i;

    // Tight: for buttons and links, where "get started" alone is too eager.
    const LOGIN_ACTION_RE =
        /(\blog ?in\b|\bsign ?in\b|\bsign ?up\b|create (a |an )?account|already have an account|continue with |sign in with )/i;

    // Enough to identify a prompt on its own. Verified against the live wall.
    const LOGIN_SIGNATURE_RE =
        /(join the most real place on the internet|i already have an account|continue with (apple|google|email|phone)|sign in with apple|reddit is better when|already a redditor)/i;

    const PEOPLE_ALSO_ASK_RE = /people also ask/i;

    const SELECTORS = {
        // The page's own content. Nothing containing one of these is ever hidden.
        contentRoot: 'main, #main-content, [role="main"], shreddit-app, #siteTable, .content[role="main"]',

        // Modal shapes, checked for login copy before being touched.
        dialog: [
            "dialog[open]", '[role="dialog"]', '[role="alertdialog"]', '[aria-modal="true"]',
            "faceplate-dialog", "shreddit-signup-drawer", "shreddit-overlay-display",
            'shreddit-async-loader[bundlename*="login"]',
            'shreddit-async-loader[bundlename*="signup"]',
            'shreddit-async-loader[bundlename*="drawer"]',
        ].join(","),

        // Specific enough to be the wall on sight, no copy needed.
        knownWall: [
            '[id*="upsell" i]',
            '[id*="login" i][id*="dialog" i]',
            '[id*="signup" i][id*="dialog" i]',
            'shreddit-async-loader[bundlename*="upsell"]',
            'shreddit-async-loader[bundlename*="login"]',
            'shreddit-async-loader[bundlename*="signup"]',
            "shreddit-signup-drawer",
        ].join(","),

        // Sibling of the backdrop, closed shadow root — counts only beside a known wall.
        wallCard: 'rpl-modal-card, [class*="modal-card" i]',

        // The login you open yourself. Hiding it would break signing in.
        userInitiatedAuth: "auth-flow-manager, [id*='auth-flow' i]",

        clickable: [
            'a[href*="/login"]', 'a[href*="/register"]', "button", '[role="button"]',
            "faceplate-tracker", '[data-testid*="login" i]', '[data-testid*="signup" i]',
        ].join(","),

        // A rail's own container, so a hit takes the panel not the prompt inside.
        railHost: '[id*="sidebar" i], [class*="sidebar" i], aside, [id*="rail" i]',

        header: 'header, [role="banner"], shreddit-header, shreddit-nav',

        peopleAlsoAsk: [
            '[data-testid*="people-also-ask" i]', '[aria-label*="people also ask" i]',
            "shreddit-related-questions",
        ].join(","),

        heading: 'h1,h2,h3,h4,h5,[role="heading"],summary,legend',

        // Real page material, and the boundary an expanding selection stops at.
        post: "shreddit-post, article, [data-testid='post-container'], [slot*='post-media'], [slot='post-image']",
        communityLink: 'a[href*="/r/"], a[href*="/user/"]',
        commentLink: 'a[href*="/comments/"]',
        loginLink: 'a[href*="/login"], a[href*="/register"]',
    };

    // --- Measuring ---

    const children = (el) => [...(el.shadowRoot?.children ?? []), ...(el.children ?? [])];

    function unionRect(a, b) {
        if (!a) return b;
        if (!b) return a;
        const left = Math.min(a.left, b.left);
        const top = Math.min(a.top, b.top);
        return new DOMRect(left, top,
            Math.max(a.right, b.right) - left, Math.max(a.bottom, b.bottom) - top);
    }

    // The wall's host is a 0×0 div painting from fixed children, so measure what it paints.
    function effectiveRect(el, depth = CONFIG.MEASURE_DEPTH) {
        const rect = el.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) return rect;
        if (depth <= 0) return rect;

        let box = null, seen = 0;
        for (const kid of children(el)) {
            if (seen++ > CONFIG.MEASURE_BREADTH) break;
            const kidRect = effectiveRect(kid, depth - 1);
            if (kidRect.width > 0 && kidRect.height > 0) box = unionRect(box, kidRect);
        }
        return box ?? rect;
    }

    function coverage(rect) {
        const w = window.innerWidth, h = window.innerHeight;
        if (w <= 0 || h <= 0) return 0;
        const cw = Math.max(0, Math.min(rect.right, w) - Math.max(rect.left, 0));
        const ch = Math.max(0, Math.min(rect.bottom, h) - Math.max(rect.top, 0));
        return (cw * ch) / (w * h);
    }

    const coverageOf = (el) => coverage(effectiveRect(el));

    // Same reasoning as effectiveRect: the host is static, its children fixed.
    function rendersFixedLayer(el, depth = 5) {
        const position = getComputedStyle(el).position;
        if (position === "fixed" || position === "sticky") return true;
        if (depth <= 0) return false;

        let seen = 0;
        for (const kid of children(el)) {
            if (seen++ > CONFIG.MEASURE_BREADTH) break;
            if (rendersFixedLayer(kid, depth - 1)) return true;
        }
        return false;
    }

    // offsetParent is null for every fixed element; checkVisibility() answers for the box.
    function isVisible(el) {
        if (!(el instanceof Element) || !el.isConnected) return false;
        const cs = getComputedStyle(el);
        if (cs.display === "none" || cs.visibility === "hidden" || cs.visibility === "collapse") return false;
        if (parseFloat(cs.opacity) <= CONFIG.MIN_OPACITY) return false;
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

    // --- Guards: what must never be hidden, applied by every rule ---

    function containsPageContent(el) {
        if (el === document.body || el === document.documentElement) return true;
        for (const root of document.querySelectorAll(SELECTORS.contentRoot)) {
            if (el === root || el.contains(root)) return true;
        }
        return false;
    }

    function isInsidePageContent(el) {
        for (const root of document.querySelectorAll(SELECTORS.contentRoot)) {
            if (root.contains(el)) return true;
        }
        return false;
    }

    function countWithin(el, selector) {
        const light = el.querySelectorAll?.(selector)?.length ?? 0;
        const shadow = el.shadowRoot?.querySelectorAll(selector)?.length ?? 0;
        return light + shadow;
    }

    // Keeps the rail rule off your subreddit list.
    const listsCommunities = (el) => countWithin(el, SELECTORS.communityLink) >= 2;

    function containsFeedContent(el) {
        return listsCommunities(el) ||
            countWithin(el, SELECTORS.post) > 0 ||
            countWithin(el, SELECTORS.commentLink) >= 2;
    }

    function isPostMedia(el) {
        if (/^(img|video|picture|source|canvas|figure)$/i.test(el.tagName)) return true;
        return !!el.closest?.(SELECTORS.post);
    }

    function isUserInitiatedAuth(el) {
        return !!(el.matches?.(SELECTORS.userInitiatedAuth) ||
                  el.closest?.(SELECTORS.userInitiatedAuth) ||
                  el.querySelector?.(SELECTORS.userInitiatedAuth));
    }

    const inHeader = (el) => !!el.closest?.(SELECTORS.header);

    function looksLikeLoginPrompt(el) {
        if (deepQueryWithin(el, SELECTORS.loginLink)) return true;
        return LOGIN_TEXT_RE.test(deepText(el));
    }

    // Which side it sits on is no signal: the right-hand panel is #left-sidebar-container.
    function isRailPrompt(el) {
        const rect = effectiveRect(el);
        if (rect.width > window.innerWidth * CONFIG.RAIL_MAX_WIDTH) return false;
        if (rect.height < CONFIG.RAIL_MIN_HEIGHT) return false;
        return !rendersFixedLayer(el);
    }

    // --- Selection: climbing from a hit to the block a person would call the prompt ---

    const outermost = (elements) => {
        const all = [...new Set(elements)];
        return all.filter((el) => !all.some((other) => other !== el && other.contains(el)));
    };

    // Structural, never textual: capping on text growth stopped one level short.
    function expandToPrompt(el) {
        let node = el, best = el, depth = 0;

        while (node && depth++ < CONFIG.MAX_ANCESTOR_CLIMB) {
            const parent = parentOf(node);
            if (!parent || parent === document.body || parent === document.documentElement) break;
            if (parent.hasAttribute?.(MARK_ATTR)) break;
            if (containsPageContent(parent)) break;
            if (containsFeedContent(parent)) break;
            if (coverageOf(parent) > 0.75) break;
            best = parent;
            node = parent;
        }
        return best;
    }

    // The rail equivalent, preferring the panel's own container on the way up.
    function expandToRailPanel(el) {
        let node = el, best = el, depth = 0;
        while (node && depth++ < CONFIG.MAX_ANCESTOR_CLIMB) {
            const parent = parentOf(node);
            if (!parent || parent === document.body || parent === document.documentElement) break;
            if (containsPageContent(parent) || containsFeedContent(parent)) break;
            if (!isRailPrompt(parent)) break;
            best = parent.matches?.(SELECTORS.railHost) ? parent : best;
            node = parent;
        }
        return best;
    }

    // --- Detection: five merged passes, each catching what the others cannot ---

    function isObstructingLayer(el) {
        if (!(el instanceof Element)) return false;
        if (el === document.body || el === document.documentElement) return false;
        if (el.hasAttribute(MARK_ATTR) || el.id === STYLE_ID || el.id === PICKER_ID) return false;
        if (!rendersFixedLayer(el)) return false;
        // Clicks passing straight through means it obstructs nothing.
        if (getComputedStyle(el).pointerEvents === "none") return false;
        if (!isVisible(el)) return false;
        if (containsPageContent(el)) return false;

        const isPrompt = looksLikeLoginPrompt(el);
        const floor = isPrompt ? CONFIG.MIN_COVERAGE_WITH_LOGIN_TEXT : CONFIG.MIN_COVERAGE;
        if (coverageOf(el) < floor) return false;
        return isPrompt || resolvedZIndex(el) >= CONFIG.MIN_Z_INDEX;
    }

    function findObstructingLayers() {
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

    function findKnownWall() {
        const hits = [];
        let present = false;

        for (const el of deepQueryAll(SELECTORS.knownWall)) {
            if (!isVisible(el) || containsPageContent(el) || containsFeedContent(el)) continue;
            present = true;
            hits.push(el);
        }

        // The backdrop and the card are siblings: hiding one leaves the other.
        if (present) {
            for (const card of deepQueryAll(SELECTORS.wallCard)) {
                if (!isVisible(card) || containsPageContent(card) || containsFeedContent(card)) continue;
                hits.push(card);
            }
        }

        // A modal <dialog>'s box may be small and its backdrop a pseudo-element.
        for (const el of deepQueryAll(SELECTORS.dialog)) {
            if (!isVisible(el) || containsPageContent(el)) continue;
            if (!looksLikeLoginPrompt(el)) continue;
            hits.push(el);
        }

        return hits;
    }

    // The pass that survives a rebuild: markup churns, copy does not.
    function findByLoginSignature() {
        const hits = [];
        for (const el of deepFindText(LOGIN_SIGNATURE_RE)) {
            if (containsPageContent(el)) continue;
            const block = expandToPrompt(el);
            if (!isVisible(block)) { note(block, "not visible"); continue; }
            if (containsPageContent(block)) { note(block, "contains page content"); continue; }
            if (containsFeedContent(block)) { note(block, "contains feed content"); continue; }
            hits.push(block);
        }
        return hits;
    }

    // Last resort, and the only pass that survives a closed shadow root.
    function findTopmostOverlay() {
        if (!document.querySelector(SELECTORS.contentRoot)) return [];

        const hits = [];
        for (const [fx, fy] of CONFIG.PROBE_POINTS) {
            const top = document.elementsFromPoint(window.innerWidth * fx, window.innerHeight * fy)[0];
            if (!top || top === document.body || top === document.documentElement) continue;
            if (isInsidePageContent(top)) continue;
            if (top.hasAttribute(MARK_ATTR) || top.id === PICKER_ID) continue;

            const block = expandToPrompt(top);
            if (!isVisible(block)) continue;
            if (containsPageContent(block) || containsFeedContent(block)) continue;
            // Either it covers a real part of the screen, or it says what it is.
            if (coverageOf(block) < 0.12 && !looksLikeLoginPrompt(block)) continue;
            hits.push(block);
        }
        return hits;
    }

    // Found through their buttons: a rail prompt often has no copy worth matching.
    function findRailPrompts() {
        const hits = [];

        for (const el of deepQueryAll(SELECTORS.clickable)) {
            if (!isVisible(el)) continue;
            if (!LOGIN_ACTION_RE.test(deepText(el, 200))) continue;
            if (el.getBoundingClientRect().top < 0) continue;
            if (inHeader(el)) continue;

            const block = expandToRailPanel(expandToPrompt(el));
            if (!block || block === el) continue;
            if (!isRailPrompt(block)) continue;
            if (listsCommunities(block)) continue;
            if (!looksLikeLoginPrompt(block)) continue;
            hits.push(block);
        }

        for (const el of deepFindText(LOGIN_SIGNATURE_RE)) {
            if (containsPageContent(el)) continue;
            const block = expandToRailPanel(expandToPrompt(el));
            if (!isVisible(block) || !isRailPrompt(block)) continue;
            if (containsPageContent(block) || containsFeedContent(block)) continue;
            if (inHeader(block)) continue;
            hits.push(block);
        }

        return hits;
    }

    // --- Rules ---

    // One rule: telling the wall and the rail prompt apart cost more than it was worth.
    function findLoginPrompts() {
        return outermost([
            ...findObstructingLayers(),
            ...findKnownWall(),
            ...findByLoginSignature(),
            ...findTopmostOverlay(),
            ...findRailPrompts(),
        ].map(expandToPrompt));
    }

    function findPeopleAlsoAsk() {
        const hits = [];

        for (const el of deepQueryAll(SELECTORS.peopleAlsoAsk)) {
            if (isVisible(el) && !containsPageContent(el)) hits.push(el);
        }

        for (const heading of deepQueryAll(SELECTORS.heading)) {
            if (!PEOPLE_ALSO_ASK_RE.test(deepText(heading, 200))) continue;
            // Climb to the section owning the heading, stopping before real results.
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

    // Which pick hid which element, so removing one frees exactly what it hid.
    const hiddenBy = new WeakMap();

    function findCustom() {
        const hits = [];
        for (const rule of settings.customRules ?? []) {
            // Already-hidden instances do not count: Reddit mounts a replacement after each hide.
            const found = resolvePath(rule.path).filter((el) => !el.hasAttribute(MARK_ATTR));

            // More matches than when stored means the path has gone ambiguous.
            if (rule.count && found.length > rule.count) {
                log("skipping ambiguous pick", rule.label, `${found.length} matches, stored ${rule.count}`);
                continue;
            }

            for (const el of found) {
                if (containsPageContent(el)) continue;
                hiddenBy.set(el, rule.id);
                hits.push(el);
            }
        }
        return hits;
    }

    const RULES = [
        { id: "peopleAlsoAsk", find: findPeopleAlsoAsk },
        { id: "loginPrompts", find: findLoginPrompts, unlocksScroll: true },
        { id: "custom", find: findCustom, always: true },
    ];

    // --- Hiding and restoring ---

    // Held directly: the DOM walk has a budget, and what it misses could never be restored.
    const hiddenElements = new Set();

    function hiddenMatching(predicate) {
        const out = new Set();
        for (const el of hiddenElements) {
            if (!el.isConnected) hiddenElements.delete(el);
            else if (el.hasAttribute(MARK_ATTR) && predicate(el)) out.add(el);
        }
        // Backstop for anything hidden before this script instance existed.
        for (const el of deepQueryAll(`[${MARK_ATTR}]`)) {
            if (predicate(el)) out.add(el);
        }
        return [...out];
    }

    // A top-layer dialog paints through display:none, so it has to be closed.
    function closeDialogsWithin(el, depth = CONFIG.MEASURE_DEPTH) {
        if (el.tagName === "DIALOG" && el.open) { try { el.close(); } catch {} }
        if (typeof el.hidePopover === "function" && el.matches?.(":popover-open")) {
            try { el.hidePopover(); } catch {}
        }
        if (depth <= 0) return;
        let seen = 0;
        for (const kid of children(el)) {
            if (seen++ > 24) break;
            closeDialogsWithin(kid, depth - 1);
        }
    }

    const markFor = (el, ruleId) =>
        ruleId === "custom" ? `custom:${hiddenBy.get(el) ?? "unknown"}` : ruleId;

    function hide(el, ruleId) {
        if (el.hasAttribute(KEEP_ATTR)) return;   // the user put this back
        closeDialogsWithin(el);
        el.setAttribute(MARK_ATTR, markFor(el, ruleId));
        el.style.setProperty("display", "none", "important");
        hiddenElements.add(el);
        log("hid", ruleId, describe(el));
    }

    function unhide(el, { keep = false } = {}) {
        el.style.removeProperty("display");
        el.removeAttribute(MARK_ATTR);
        hiddenElements.delete(el);
        if (keep) el.setAttribute(KEEP_ATTR, "1");
    }

    // `ruleId` undefined means everything; "custom" means every pick.
    function restore(ruleId) {
        const matches = hiddenMatching((el) => {
            if (!ruleId) return true;
            const mark = el.getAttribute(MARK_ATTR) ?? "";
            return ruleId === "custom" ? mark.startsWith("custom") : mark === ruleId;
        });
        for (const el of matches) unhide(el);
        if (!ruleId || ruleId === "loginPrompts") relockScroll();
    }

    const SCROLL_LOCK_CLASS_RE =
        /(^|[-_])(scroll[-_]?lock(ed)?|no[-_]?scroll|overflow[-_]?hidden|modal[-_]?open|prevent[-_]?scroll|is[-_]?locked)($|[-_])/i;
    const SCROLL_LOCK_PROPS = ["overflow", "overflow-x", "overflow-y", "position", "top",
        "height", "max-height", "padding-right", "touch-action", "overscroll-behavior", "filter"];
    const SCROLL_LOCK_ATTRS = ["data-scroll-locked", "data-lock-scroll", "data-scroll-lock",
        "data-modal-open", "scroll-lock"];

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
            for (const prop of SCROLL_LOCK_PROPS) el.style.removeProperty(prop);
            for (const cls of [...el.classList]) {
                if (SCROLL_LOCK_CLASS_RE.test(cls)) el.classList.remove(cls);
            }
            for (const attr of SCROLL_LOCK_ATTRS) el.removeAttribute(attr);
        }

        // Inline as well, because a page CSP can refuse a stylesheet we add.
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

    function relockScroll() {
        document.getElementById(STYLE_ID)?.remove();
        document.documentElement.style.removeProperty("overflow");
        document.body?.style.removeProperty("overflow");
        document.body?.style.removeProperty("position");
    }

    // --- Sweeping ---

    const counts = { loginPrompts: 0, peopleAlsoAsk: 0, custom: 0 };
    let lastSweepAt = 0, sweepScheduled = false, lastHref = location.href, observer = null;

    function sweep(reason) {
        lastSweepAt = Date.now();
        const hidden = {};

        for (const rule of RULES) {
            if (!rule.always && !settings[rule.id]) continue;

            let found = [];
            try {
                found = rule.find();
            } catch (err) {
                fail(`rule ${rule.id} failed:`, err);
                continue;
            }

            // Picks skip the media and auth guards: hiding one by hand is a choice.
            const allowed = found.filter((el) =>
                !el.hasAttribute(KEEP_ATTR) &&
                (rule.id === "custom" || (!isPostMedia(el) && !isUserInitiatedAuth(el))));

            for (const el of allowed) hide(el, rule.id);
            if (allowed.length) {
                hidden[rule.id] = allowed.length;
                counts[rule.id] += allowed.length;
                if (rule.unlocksScroll) unlockScroll();
            }
        }

        // The wall can freeze the page before we manage to hide it.
        if (settings.loginPrompts && document.body &&
            getComputedStyle(document.body).overflow === "hidden") {
            unlockScroll();
        }

        if (Object.keys(hidden).length) log("sweep", reason, hidden);
        return { ok: true, hidden, totals: { ...counts } };
    }

    function scheduleSweep(reason) {
        if (sweepScheduled) return;
        sweepScheduled = true;
        const wait = Math.max(0, CONFIG.SWEEP_THROTTLE_MS - (Date.now() - lastSweepAt));
        setTimeout(() => {
            sweepScheduled = false;
            requestAnimationFrame(() => sweep(reason));
        }, wait);
    }

    // Everything registers through on(), so teardown can remove all of it.
    const unsubscribes = [];

    function on(target, type, handler, options) {
        target.addEventListener(type, handler, options);
        unsubscribes.push(() => target.removeEventListener(type, handler, options));
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
                        invalidateRootCache();   // new nodes bring new shadow roots
                        return scheduleSweep("mutation");
                    }
                }
            }
        });
        observer.observe(document.documentElement, { childList: true, subtree: true });

        // history.pushState cannot be patched from an isolated world; these cover SPA nav.
        const onNav = () => {
            lastHref = location.href;
            invalidateRootCache();
            scheduleSweep("navigation");
        };
        on(window, "popstate", onNav);
        on(window, "hashchange", onNav);
        // The wall is often raised on scroll depth rather than on navigation.
        on(window, "scroll", () => scheduleSweep("scroll"), { passive: true });

        // Works even when the toolbar button does not, in a stale tab say.
        on(window, "keydown", (event) => {
            if (event.ctrlKey && event.shiftKey && (event.key === "H" || event.key === "h")) {
                event.preventDefault();
                event.stopPropagation();
                togglePicker();
            }
        }, true);
    }

    function teardown() {
        observer?.disconnect();
        observer = null;
        stopPicker();
        for (const off of unsubscribes.splice(0)) {
            try { off(); } catch {}
        }
        api.storage.onChanged.removeListener(onSettingsChanged);
        api.runtime.onMessage.removeListener(onMessage);
    }

    // --- Picker: point at something, store a selector path, re-apply it ---

    let picker = null;

    // Touch has no hover, right-click or keyboard: it gets a control bar.
    const TOUCH = matchMedia("(hover: none) and (pointer: coarse)").matches;

    // CSSOM, not a stylesheet: Reddit's CSP can refuse a <style> we add.
    const PICKER_STYLES = {
        // The reset undoes the UA styles a popover carries.
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
        // The one part of the overlay that takes taps.
        controls: "position:fixed;left:50%;bottom:20px;top:auto;right:auto;transform:translateX(-50%);" +
                  "margin:0;padding:0;width:auto;height:auto;max-width:none;border:0;" +
                  "background:transparent;display:flex;gap:8px;pointer-events:auto;",
        button: "font:600 14px/1 system-ui,-apple-system,sans-serif;color:#fff;background:#1c1c1e;" +
                "border:0;border-radius:999px;padding:12px 16px;-webkit-appearance:none;" +
                "touch-action:manipulation;box-shadow:0 4px 16px rgba(0,0,0,0.4);",
    };

    const HINT_TEXT = TOUCH
        ? "Tap what you want gone, then Hide"
        : "Click to hide  ·  ⇧ or ↑ wider  ·  ↓ narrower  ·  ⌥ reach behind  ·  Esc to finish";

    // A manual popover joins the top layer without making the page inert.
    function raiseToTopLayer(el) {
        try {
            el.setAttribute("popover", "manual");
            el.showPopover();
        } catch {
            el.removeAttribute("popover");   // older Safari: the z-index carries it
        }
    }

    // Hovering lands on whatever owns the pixel, so climb to the smallest real block.
    function snapToBlock(el) {
        let node = el, depth = 0;
        if (node instanceof SVGElement && node.ownerSVGElement) node = node.ownerSVGElement;

        while (node && depth++ < 8) {
            const parent = parentOf(node);
            if (!parent || parent === document.body || parent === document.documentElement) break;
            if (containsPageContent(parent) || containsFeedContent(parent)) break;

            const rect = node.getBoundingClientRect();
            const parentRect = parent.getBoundingClientRect();
            const display = getComputedStyle(node).display;

            const isInline = /^(inline|inline-block|inline-flex|contents|ruby)/.test(display);
            const wrappedExactly = Math.abs(rect.width - parentRect.width) <= 4 &&
                                   Math.abs(rect.height - parentRect.height) <= 4;
            const onlyChild = parent.children.length === 1;
            const tooSmall = rect.width < 24 || rect.height < 12;

            if (!(isInline || wrappedExactly || onlyChild || tooSmall)) break;
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
        raiseToTopLayer(host);

        // The popup closes itself, leaving the page unfocused and the arrow keys dead.
        try {
            window.focus();
            host.tabIndex = -1;
            host.focus({ preventScroll: true });
        } catch {}

        let hovered = null;      // what the cursor is over
        let target = null;       // what a click would take
        let base = null;         // what the snap chose, before ⇧ widening
        let widening = false;
        let hiddenHere = 0;

        // Checked by every handler, so a listener outliving cleanup cannot eat clicks.
        let live = true;

        // A highlight lost to a DOM replacement leaves a picker eating clicks invisibly.
        const ensureHost = () => {
            if (host.isConnected) return;
            document.documentElement.appendChild(host);
            raiseToTopLayer(host);
        };

        const paint = () => {
            if (!live) return;
            ensureHost();
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
            box.style.borderRadius = getComputedStyle(target).borderRadius || "4px";
        };

        // Say what a click will take, so a bad selection shows before it happens.
        const setTarget = (el) => {
            target = el;
            paint();
            if (!target) { hint.textContent = HINT_TEXT; return; }
            const rect = effectiveRect(target);
            hint.textContent = `${describe(target).slice(0, 44)}  ·  ` +
                `${Math.round(rect.width)}×${Math.round(rect.height)}` +
                (TOUCH ? "" : "  ·  ↑ wider  ↓ narrower  ·  Esc to finish");
        };

        // ⌥ reaches past a full-viewport overlay, which the hit test returns everywhere.
        const pointTarget = (x, y, behind) => {
            if (!behind) return deepElementFromPoint(x, y);
            const stack = document.elementsFromPoint(x, y).filter((el) => !host.contains(el));
            return stack[1] ?? stack[0] ?? null;
        };

        const onMove = (event) => {
            if (!live) return;
            const el = pointTarget(event.clientX, event.clientY, event.altKey);
            // ⇧ rides on the mouse event, so widening works without focus.
            if (el && el === hovered && event.shiftKey !== widening) {
                widening = event.shiftKey;
                setTarget(widening ? (parentOf(base) ?? base) : base);
                return;
            }
            if (!el || el === hovered || host.contains(el)) return;
            widening = event.shiftKey;
            hovered = el;
            base = expandToPrompt(snapToBlock(el));
            setTarget(widening ? (parentOf(base) ?? base) : base);
        };

        // ↓ walks back down towards whatever the cursor is actually over.
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
            if (!live) return;
            if (event.key === "Escape") {
                event.preventDefault();
                stopPicker();
            } else if (event.key === "ArrowUp") {
                event.preventDefault();
                const parent = target && parentOf(target);
                if (parent && parent !== document.body && parent !== document.documentElement) {
                    setTarget(parent);
                }
            } else if (event.key === "ArrowDown") {
                event.preventDefault();
                const child = childTowardsHover();
                if (child) setTarget(child);
            }
        };

        // Capture phase, so Reddit's own handlers never see any of this.
        const swallow = (event) => {
            if (!live) return;
            event.preventDefault();
            event.stopPropagation();
        };

        // The way out that needs no keyboard focus.
        const onContextMenu = (event) => {
            if (!live) return;
            swallow(event);
            stopPicker();
        };

        // Shared by a click and by the touch control bar's Hide button.
        const hidePicked = () => {
            const picked = target;
            if (!picked) return;
            if (containsPageContent(picked)) {
                hint.textContent = "That block contains the page itself — take something smaller";
                return;
            }

            const path = pathFor(picked);
            const rule = {
                id: `custom-${Date.now()}`,
                path,
                label: describe(picked),
                // What the path matched when stored, for the ambiguity guard.
                count: Math.max(1, resolvePath(path).length),
            };

            const customRules = [...(settings.customRules ?? []), rule];
            settings.customRules = customRules;
            api.storage.local.set({ customRules });

            // Picking again is an explicit reversal of "keep this visible".
            picked.removeAttribute(KEEP_ATTR);
            // Ownership before hiding: an untagged pick reads as an orphan and gets restored.
            hiddenBy.set(picked, rule.id);
            hide(picked, "custom");
            counts.custom++;
            hiddenHere++;

            if (!resolvePath(path).includes(picked)) {
                warn("this pick will not survive a reload — no stable selector path " +
                     "leads back to it:", path.join("  ▸  "), picked);
            }
            log("picked", rule.label, path.join("  ▸  "));

            hint.textContent =
                `Hidden ${hiddenHere} element${hiddenHere === 1 ? "" : "s"}  ·  keep clicking  ·  Esc to finish`;

            // What was under the cursor is gone; wait for the next move.
            hovered = null;
            target = null;
            paint();
        };

        // Picking stays on until Esc, so a page can be cleaned up in one go.
        const onClick = (event) => {
            if (!live) return;
            if (host.contains(event.target)) return;   // the control bar's buttons
            swallow(event);
            // On touch a tap only selects, so Hide can be reconsidered first.
            if (!TOUCH) hidePicked();
        };

        // No preventDefault: the page still has to scroll while picking.
        const onTouch = (event) => {
            if (!live) return;
            const touch = event.touches[0];
            if (!touch) return;
            const el = pointTarget(touch.clientX, touch.clientY, false);
            if (!el || host.contains(el)) return;
            hovered = el;
            base = expandToPrompt(snapToBlock(el));
            setTarget(base);
        };

        const widen = () => {
            const parent = target && parentOf(target);
            if (parent && parent !== document.body && parent !== document.documentElement) setTarget(parent);
        };

        const narrow = () => {
            const child = childTowardsHover();
            if (child) setTarget(child);
        };

        if (TOUCH) {
            hint.style.bottom = "78px";
            const controls = document.createElement("div");
            controls.style.cssText = PICKER_STYLES.controls;
            for (const [label, action] of [["Wider", widen], ["Narrower", narrow],
                                           ["Hide", hidePicked], ["Done", () => stopPicker()]]) {
                const button = document.createElement("button");
                button.type = "button";
                button.textContent = label;
                button.style.cssText = PICKER_STYLES.button;
                button.addEventListener("click", (event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    action();
                });
                controls.append(button);
            }
            host.append(controls);
        }

        const bindings = [
            ["click", onClick, true],
            ["keydown", onKey, true],
            ["scroll", paint, true],
            ["resize", paint, true],
            // Nothing should come back to a tab still eating its own clicks.
            ["pagehide", () => stopPicker(), true],
        ];

        // On touch, swallowing mousedown would stop the page scrolling too.
        bindings.push(...(TOUCH
            ? [["touchstart", onTouch, true]]
            : [["mousemove", onMove, true],
               ["mousedown", swallow, true],
               ["mouseup", swallow, true],
               ["pointerdown", swallow, true],
               ["contextmenu", onContextMenu, true]]));
        for (const [type, handler, capture] of bindings) {
            window.addEventListener(type, handler, capture);
        }

        picker = { host, bindings, count: () => hiddenHere, end: () => { live = false; } };
        return { ok: true, active: true };
    }

    function stopPicker() {
        if (!picker) return { ok: true, active: false };
        const { host, bindings, count, end } = picker;
        end();   // before anything that could throw: the handlers go inert first
        for (const [type, handler, capture] of bindings) {
            window.removeEventListener(type, handler, capture);
        }
        host.remove();
        picker = null;

        const hidden = count();
        if (hidden) toast(`Hidden ${hidden} element${hidden === 1 ? "" : "s"}`);
        return { ok: true, active: false, hidden };
    }

    const togglePicker = () => (picker ? stopPicker() : startPicker());

    // The popup is closed by the time a pick lands, so confirm on the page.
    function toast(text) {
        const el = document.createElement("div");
        el.style.cssText = PICKER_STYLES.hint;
        el.textContent = text;
        document.documentElement.appendChild(el);
        raiseToTopLayer(el);
        setTimeout(() => el.remove(), 2000);
    }

    // --- Diagnostics ---

    // Stylesheet and script text lives in the DOM too and reads as gibberish.
    const looksLikeCode = (text) => /[{};]/.test(text) || /^[:.#@][a-z-]/i.test(text);

    function describe(el) {
        const raw = (deepText(el, 200) || "").replace(/\s+/g, " ").trim();
        const text = raw && !looksLikeCode(raw) ? raw.slice(0, 40) : "";
        return text ? `${el.tagName.toLowerCase()} — “${text}”` : el.tagName.toLowerCase();
    }

    // Debug-only, capped, once per element, so it never becomes noise.
    const noted = new WeakSet();
    let notesLeft = 20;

    function note(el, reason) {
        if (!settings.debug || notesLeft <= 0 || noted.has(el)) return;
        noted.add(el);
        notesLeft--;
        console.log(`${LOG_PREFIX} not hiding ${describe(el)} — ${reason}`, el);
    }

    // Every gate's answer for one element: __redditLoginBypass__.explain($0)
    function explain(el) {
        if (!(el instanceof Element)) return "not an element";
        const rect = effectiveRect(el);
        const facts = {
            size: `${Math.round(rect.width)}×${Math.round(rect.height)}`,
            coverage: coverageOf(el).toFixed(2),
            visible: isVisible(el),
            fixedLayer: rendersFixedLayer(el),
            railPrompt: isRailPrompt(el),
            loginText: looksLikeLoginPrompt(el),
            pageContent: containsPageContent(el),
            feedContent: containsFeedContent(el),
            postMedia: isPostMedia(el),
            userAuth: isUserInitiatedAuth(el),
            keep: el.hasAttribute(KEEP_ATTR),
            hiddenBy: el.getAttribute(MARK_ATTR) ?? "-",
        };
        return `${describe(el)}\n` +
            Object.entries(facts).map(([k, v]) => `  ${k}: ${v}`).join("\n");
    }

    // --- Settings, messages, startup ---

    function onSettingsChanged(changes, area) {
        if (area !== "local") return;

        for (const [key, { newValue }] of Object.entries(changes)) {
            if (!(key in settings)) continue;
            settings[key] = newValue;
            if (newValue === false) restore(key);
        }

        // Matched by the id on the element: a stale path used to strand hidden elements.
        if (changes.customRules) {
            const oldIds = (changes.customRules.oldValue ?? []).map((r) => r.id);
            const newIds = new Set((changes.customRules.newValue ?? []).map((r) => r.id));
            const droppedMarks = new Set(
                oldIds.filter((id) => !newIds.has(id)).map((id) => `custom:${id}`));
            const knownMarks = new Set([...newIds].map((id) => `custom:${id}`));

            // Explicitly un-picked: keep it visible, no rule may re-hide it.
            for (const el of hiddenMatching((el) => droppedMarks.has(el.getAttribute(MARK_ATTR)))) {
                unhide(el, { keep: true });
            }
            // Unknown provenance, so no `keep` — the rules stay free to act on it.
            for (const el of hiddenMatching((el) => {
                const mark = el.getAttribute(MARK_ATTR) ?? "";
                return mark.startsWith("custom") && !knownMarks.has(mark);
            })) {
                unhide(el);
            }
        }

        sweep("settings changed");
    }

    function onMessage(message) {
        switch (message?.type) {
            case "ping":
                return Promise.resolve({ ok: true, version: VERSION });

            case "status":
                return Promise.resolve({ ok: true, totals: { ...counts }, picking: !!picker });

            case "rescan":
                return Promise.resolve(sweep("popup"));

            case "restoreAll": {
                // Picks only. What a toggle hid comes back by switching it off.
                const picked = hiddenMatching((el) =>
                    (el.getAttribute(MARK_ATTR) ?? "").startsWith("custom"));
                for (const el of picked) unhide(el);
                return Promise.resolve({ ok: true, restored: picked.length });
            }

            case "pick":
                try {
                    return Promise.resolve(togglePicker());
                } catch (err) {
                    fail("picker failed:", err);
                    return Promise.resolve({ ok: false, error: String(err?.message ?? err) });
                }

            default:
                return undefined;
        }
    }

    api.storage.onChanged.addListener(onSettingsChanged);
    api.runtime.onMessage.addListener(onMessage);

    Object.defineProperty(globalThis, STATE_KEY, {
        value: {
            version: VERSION,
            sweep, restore, teardown,
            startPicker, stopPicker, togglePicker,
            disarm: teardown,        // the name older builds know it by
            config: CONFIG,
            get settings() { return settings; },
            explain,
            pathFor,
            // Each strategy alone: __redditLoginBypass__.find.signature()
            find: {
                loginPrompts: findLoginPrompts,
                peopleAlsoAsk: findPeopleAlsoAsk,
                layers: findObstructingLayers,
                known: findKnownWall,
                signature: findByLoginSignature,
                topmost: findTopmostOverlay,
                rail: findRailPrompts,
            },
            picks: () => (settings.customRules ?? []).map((rule, i) =>
                `${i + 1}. ${rule.label}\n   ${rule.path.join("  ▸  ")}`).join("\n") || "(none)",
            hidden: () => hiddenMatching(() => true).map((el) =>
                `${el.getAttribute(MARK_ATTR)}  ${describe(el)}`),
        },
        configurable: true,
    });

    function loadSettings(stored) {
        settings = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS)) {
            if (key in stored) settings[key] = stored[key];
        }
        // The two login rules were merged into one; carry the old key forward.
        if (!("loginPrompts" in stored) && LEGACY_TOGGLE_KEY in stored) {
            settings.loginPrompts = stored[LEGACY_TOGGLE_KEY] !== false;
        }
    }

    api.storage.local.get().then((stored) => {
        loadSettings(stored ?? {});
        arm();
        sweep("initial");
        // The wall usually mounts a beat after the page, and sometimes remounts.
        for (const delay of [200, 600, 1200, 2500]) {
            setTimeout(() => sweep(`retry@${delay}ms`), delay);
        }
    }).catch((err) => {
        fail("could not read settings, using defaults:", err);
        arm();
        sweep("initial (defaults)");
    });
})();
