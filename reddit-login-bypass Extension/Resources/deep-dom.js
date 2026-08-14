//
//  deep-dom.js
//  Shadow-DOM-aware DOM helpers, shared by content.js.
//
//  Reddit renders most of its UI inside the shadow roots of <shreddit-*> and
//  <faceplate-*> custom elements. document.querySelectorAll cannot see into
//  them, and document.elementsFromPoint retargets its results to the outermost
//  shadow host, so plain DOM queries miss everything that matters here.
//
//  Loaded as a classic content script (no ES modules — manifest-declared
//  content scripts cannot use import), so it exports through one global.
//

(() => {
    "use strict";

    const ROOT_CACHE_MS = 1000;
    // Generous: a long Reddit feed can run past a smaller budget before it
    // reaches the shadow roots that matter, and anything beyond the budget is
    // invisible to every rule and to restoring alike.
    const MAX_NODES = 200000;

    let rootCache = { at: 0, roots: [] };

    // document plus every open shadow root on the page.
    function allRoots() {
        const now = Date.now();
        if (now - rootCache.at < ROOT_CACHE_MS && rootCache.roots.length) return rootCache.roots;

        const roots = [document];
        let budget = MAX_NODES;

        for (let i = 0; i < roots.length; i++) {
            let elements;
            try {
                elements = roots[i].querySelectorAll("*");
            } catch {
                continue;
            }
            for (const el of elements) {
                if (budget-- <= 0) break;
                if (el.shadowRoot) roots.push(el.shadowRoot);
            }
            if (budget <= 0) break;
        }

        rootCache = { at: now, roots };
        return roots;
    }

    function invalidateRootCache() {
        rootCache = { at: 0, roots: [] };
    }

    // querySelectorAll across every root.
    function deepQueryAll(selector) {
        const out = [];
        for (const root of allRoots()) {
            let found;
            try {
                found = root.querySelectorAll(selector);
            } catch {
                continue;
            }
            for (const el of found) out.push(el);
        }
        return out;
    }

    // The genuinely topmost element at a point: descend through shadow roots
    // instead of accepting the retargeted host document.elementFromPoint gives.
    function deepElementFromPoint(x, y) {
        let el = document.elementFromPoint(x, y);
        let guard = 0;
        while (el?.shadowRoot && guard++ < 20) {
            const inner = el.shadowRoot.elementFromPoint?.(x, y);
            if (!inner || inner === el) break;
            el = inner;
        }
        return el;
    }

    // Parent within the current tree, stepping out to the shadow host at the top.
    function parentOf(node) {
        if (node.parentElement) return node.parentElement;
        const root = node.getRootNode?.();
        return root instanceof ShadowRoot ? root.host : null;
    }

    // Text content including the element's own shadow root.
    function deepText(el, limit = 800) {
        let text = (el.textContent || "").slice(0, limit);
        if (el.shadowRoot) text += " " + (el.shadowRoot.textContent || "").slice(0, limit);
        return text;
    }

    // querySelector that also looks inside this element's shadow root.
    function deepQueryWithin(el, selector) {
        return el.querySelector?.(selector) || el.shadowRoot?.querySelector(selector) || null;
    }

    // Elements whose own text matches — across every root. Reddit's markup
    // changes constantly but its copy does not, so a distinctive phrase is the
    // most durable handle there is on a prompt.
    function deepFindText(regex, budget = 40000) {
        const out = [];
        for (const root of allRoots()) {
            let walker;
            try {
                walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
            } catch {
                continue;
            }
            let node;
            while ((node = walker.nextNode())) {
                if (budget-- <= 0) return out;
                const text = node.nodeValue;
                // Long nodes are scripts, JSON blobs and inline SVG stylesheets.
                if (text && text.length < 300 && regex.test(text) && node.parentElement) {
                    out.push(node.parentElement);
                }
            }
        }
        return out;
    }

    // -----------------------------------------------------------------------
    // Selector paths — how a picked element is remembered across page loads.
    //
    // A path is one CSS selector per shadow level, outermost first:
    //   ["shreddit-app", "faceplate-dialog", "div.prompt > button"]
    // Each hop is resolved inside the previous hop's shadow root.
    // -----------------------------------------------------------------------

    // Reddit mixes stable utility classes with hashed ones; keep the readable.
    function stableClasses(el) {
        if (typeof el.className !== "string") return [];
        return el.className.trim().split(/\s+/).filter((cls) =>
            cls &&
            cls.length <= 30 &&
            /^[a-zA-Z][\w:-]*$/.test(cls) &&
            !/^[a-zA-Z]?[0-9a-f]{6,}$/i.test(cls) &&
            !/\d{4,}/.test(cls)
        ).slice(0, 3);
    }

    function nthOfType(el) {
        const parent = el.parentElement;
        if (!parent) return 0;
        const sameTag = [...parent.children].filter((c) => c.tagName === el.tagName);
        return sameTag.length > 1 ? sameTag.indexOf(el) + 1 : 0;
    }

    function selectorFor(el) {
        const tag = el.tagName.toLowerCase();
        if (el.id && /^[a-zA-Z][\w-]*$/.test(el.id)) return `${tag}#${CSS.escape(el.id)}`;
        const classes = stableClasses(el).map((c) => `.${CSS.escape(c)}`).join("");
        const nth = nthOfType(el);
        return tag + classes + (nth ? `:nth-of-type(${nth})` : "");
    }

    // Build a selector for `el` within `root`, lengthening the ancestor chain
    // until it is unambiguous.
    function cssPathWithin(el, root) {
        const parts = [];
        let node = el;
        while (node && node !== root && node.nodeType === Node.ELEMENT_NODE) {
            parts.unshift(selectorFor(node));
            const candidate = parts.join(" > ");
            try {
                const matches = root.querySelectorAll(candidate);
                if (matches.length === 1 && matches[0] === el) return candidate;
            } catch {
                // Malformed selector: keep climbing and try a longer one.
            }
            node = node.parentElement;
            if (parts.length > 8) break;
        }
        return parts.join(" > ");
    }

    function pathFor(el) {
        const hops = [];
        let node = el, guard = 0;
        while (node && guard++ < 12) {
            const root = node.getRootNode();
            hops.unshift(cssPathWithin(node, root));
            if (root instanceof ShadowRoot) node = root.host;
            else break;
        }
        return hops;
    }

    // Resolve a stored path back to live elements. The last hop may match more
    // than one element, which is what makes a picked rule reusable.
    function resolvePath(hops) {
        if (!Array.isArray(hops) || !hops.length) return [];
        let root = document;
        for (let i = 0; i < hops.length - 1; i++) {
            let host;
            try {
                host = root.querySelector(hops[i]);
            } catch {
                return [];
            }
            if (!host?.shadowRoot) return [];
            root = host.shadowRoot;
        }
        try {
            return [...root.querySelectorAll(hops[hops.length - 1])];
        } catch {
            return [];
        }
    }

    globalThis.__redditBypassDom = {
        allRoots, invalidateRootCache, deepQueryAll, deepElementFromPoint,
        parentOf, deepText, deepQueryWithin, deepFindText, pathFor, resolvePath,
    };
})();
