//
//  inspect-overlay.js — recon helper. NOT part of the extension bundle.
//
//  Paste into Safari's Web Inspector console on the Reddit page that is
//  misbehaving. Read-only: it reports what the extension's rules would see and
//  prints trimmed markup for each candidate, so the output can be pasted back
//  to tune the selectors in content.js.
//

(() => {
    const PROBE_POINTS = [[0.5, 0.5], [0.5, 0.28], [0.5, 0.72], [0.22, 0.5], [0.78, 0.5]];
    const MAX_CLIMB = 14;
    const LOGIN_TEXT_RE =
        /\b(log ?in|sign ?in|sign ?up|create (a |an )?account|continue with (google|apple|email|phone)|join reddit|reddit is better when)\b/i;

    const parentOf = (n) => n.parentElement || n.getRootNode?.().host || null;

    const coverage = (r) => {
        const w = innerWidth, h = innerHeight;
        const cw = Math.max(0, Math.min(r.right, w) - Math.max(r.left, 0));
        const ch = Math.max(0, Math.min(r.bottom, h) - Math.max(r.top, 0));
        return +((cw * ch) / (w * h)).toFixed(3);
    };

    const resolvedZ = (el) => {
        let n = el, best = 0, d = 0;
        while (n && n !== document.documentElement && d++ < MAX_CLIMB) {
            const z = parseInt(getComputedStyle(n).zIndex, 10);
            if (!isNaN(z) && z > best) best = z;
            n = parentOf(n);
        }
        return best;
    };

    const describe = (el) => {
        const cls = typeof el.className === "string" && el.className
            ? "." + el.className.trim().split(/\s+/).slice(0, 3).join(".")
            : "";
        return el.tagName.toLowerCase() + (el.id ? `#${el.id}` : "") + cls;
    };

    // Opening tag plus a little text — enough to write a selector from.
    const markup = (el) => {
        const open = el.outerHTML.slice(0, el.outerHTML.indexOf(">") + 1);
        const text = (el.textContent || "").trim().replace(/\s+/g, " ").slice(0, 80);
        return `${open.slice(0, 220)}  …  "${text}"`;
    };

    const row = (el, extra = {}) => {
        const cs = getComputedStyle(el);
        return {
            element: describe(el),
            position: cs.position,
            zIndex: resolvedZ(el),
            coverage: coverage(el.getBoundingClientRect()),
            pointerEvents: cs.pointerEvents,
            visible: el.checkVisibility ? el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }) : "n/a",
            loginText: LOGIN_TEXT_RE.test((el.textContent || "").slice(0, 800)),
            shadowRoot: !!el.shadowRoot,
            ...extra,
            markup: markup(el),
            node: el,
        };
    };

    const report = (title, rows) => {
        console.group(`%c[recon] ${title} — ${rows.length}`, "font-weight:bold");
        if (rows.length) {
            console.table(rows.map(({ node, markup, ...rest }) => rest));
            rows.forEach((r, i) => console.log(`${i}:`, r.markup, r.node));
        } else {
            console.log("(none)");
        }
        console.groupEnd();
        return rows;
    };

    // 1. Whatever is topmost under the probe points.
    const seen = new Set(), layers = [];
    for (const [fx, fy] of PROBE_POINTS) {
        let n = document.elementsFromPoint(innerWidth * fx, innerHeight * fy)[0], d = 0;
        while (n && n !== document.body && n !== document.documentElement && d++ < MAX_CLIMB) {
            if (!seen.has(n)) {
                seen.add(n);
                const cs = getComputedStyle(n);
                if (cs.position === "fixed" || cs.position === "sticky") layers.push(row(n, { depth: d }));
            }
            n = parentOf(n);
        }
    }
    report("fixed/sticky layers under the probe points", layers.sort((a, b) => b.coverage - a.coverage));

    // 2. Dialog-ish containers — the likely shape of the wall.
    const dialogs = [...document.querySelectorAll(
        'dialog, [role="dialog"], [role="alertdialog"], [aria-modal="true"], faceplate-dialog, ' +
        'shreddit-signup-drawer, shreddit-overlay-display, shreddit-async-loader'
    )].map((el) => row(el, { open: el.hasAttribute("open") || el.open === true }));
    report("dialogs / async loaders", dialogs);

    // 3. Left-rail login anchors (rule 2).
    const anchors = [...document.querySelectorAll('a[href*="/login"], a[href*="/register"]')]
        .map((el) => row(el, {
            left: Math.round(el.getBoundingClientRect().left),
            inLeftRail: el.getBoundingClientRect().left <= innerWidth * 0.45,
        }));
    report("login / register anchors", anchors);

    // 4. "People also ask about" (rule 3).
    const paa = [...document.querySelectorAll('h1,h2,h3,h4,h5,[role="heading"],summary,legend')]
        .filter((el) => /people also ask/i.test(el.textContent || ""))
        .map((el) => row(el));
    report('"People also ask about" headings', paa);

    // 5. Scroll-lock state.
    const lockState = (el, label) => {
        const cs = getComputedStyle(el);
        return {
            target: label,
            classes: el.className || "(none)",
            inlineStyle: el.getAttribute("style") || "(none)",
            overflow: cs.overflow, position: cs.position, top: cs.top, filter: cs.filter,
        };
    };
    console.group("%c[recon] scroll-lock state", "font-weight:bold");
    console.table([lockState(document.documentElement, "<html>"), lockState(document.body, "<body>")]);
    console.groupEnd();

    console.log("%c[recon] extension loaded on this page: " +
        (globalThis.__redditLoginBypass__ ? "yes" : "NO — check Safari's extension permissions for reddit.com"),
        `color:${globalThis.__redditLoginBypass__ ? "#2ea043" : "#d1242f"};font-weight:bold`);

    return { layers, dialogs, anchors, paa };
})();
