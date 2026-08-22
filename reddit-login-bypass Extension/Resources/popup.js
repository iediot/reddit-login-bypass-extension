// popup.js — toggles write to storage.local; the content script applies them live.

const api = globalThis.browser ?? globalThis.chrome;

const RULE_IDS = ["loginPrompts", "peopleAlsoAsk"];
// The two login rules were merged into one; carry the old key forward.
const LEGACY_TOGGLE_KEY = "loginWall";
const DEFAULTS = Object.fromEntries(RULE_IDS.map((id) => [id, true]));

const NOT_RUNNING =
    "Not running here — open a Reddit page and allow the extension on reddit.com.";

const UNREACHABLE = "Could not reach this page. Reload it (⌘R) and try again.";

const NOT_REDDIT = "Only runs on reddit.com — nothing to do on this page.";

const REDDIT_HOST_RE = /(^|\.)reddit\.com$/i;

function isRedditUrl(url) {
    try {
        return REDDIT_HOST_RE.test(new URL(url).hostname);
    } catch {
        return false;
    }
}

const statusEl = document.getElementById("status");
const pickButton = document.getElementById("pick");

const setStatus = (text) => { statusEl.textContent = text; };
const setPicking = (active) => { pickButton.textContent = active ? "Stop picking" : "Pick element"; };

// Why the last send() could not reach the page, for the status line.
let lastFailure = "";

// Talks to the page, and re-injects the scripts if a stale copy does not answer.
async function send(message) {
    lastFailure = "";
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");

    const ask = () => api.tabs.sendMessage(tab.id, message).catch(() => undefined);

    // Messaging is safe anywhere: it only reaches our own content script.
    let result = await ask();
    if (result !== undefined) return result;

    // Injecting is not: Safari can grant every site, and this ran on any open tab.
    if (!isRedditUrl(tab.url ?? "")) {
        lastFailure = NOT_REDDIT;
        return undefined;
    }

    if (!api.scripting) {
        lastFailure = "Safari has not granted the scripting permission yet — " +
                      "toggle the extension off and on in Safari ▸ Settings ▸ Extensions.";
        return undefined;
    }
    try {
        await api.scripting.executeScript({
            target: { tabId: tab.id },
            files: ["deep-dom.js", "content.js"],
        });
    } catch (err) {
        lastFailure = String(err?.message ?? err);
        return undefined;
    }
    for (let attempt = 0; attempt < 3; attempt++) {
        await new Promise((done) => setTimeout(done, 80));
        result = await ask();
        if (result !== undefined) return result;
    }
    lastFailure = "injected, but the page did not answer";
    return result;
}

async function activeRedditTabId() {
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    return isRedditUrl(tab?.url ?? "") ? tab?.id : undefined;
}

const unreachable = () =>
    lastFailure === NOT_REDDIT ? NOT_REDDIT
        : lastFailure ? `Could not reach this page: ${lastFailure}`
        : UNREACHABLE;

async function load() {
    const stored = await api.storage.local.get();
    const settings = { ...DEFAULTS, ...stored };
    if (!("loginPrompts" in stored) && LEGACY_TOGGLE_KEY in stored) {
        settings.loginPrompts = stored[LEGACY_TOGGLE_KEY] !== false;
    }

    for (const id of RULE_IDS) {
        const input = document.getElementById(id);
        input.checked = settings[id] !== false;
        input.addEventListener("change", async () => {
            await api.storage.local.set({ [id]: input.checked });
            setStatus(input.checked ? "Rule on." : "Rule off — items restored.");

            // Nothing listening: reload, so the setting visibly takes effect.
            const applied = await send({ type: "rescan" });
            if (applied === undefined) {
                const tabId = await activeRedditTabId();
                if (tabId) {
                    setStatus("Applied — reloading the page…");
                    api.tabs.reload(tabId);
                }
            }
        });
    }

    try {
        const status = await send({ type: "status" });
        if (status) setPicking(status.picking);
        else if (lastFailure === NOT_REDDIT) {
            // Toggles are settings and still work; only the picker needs a page.
            pickButton.disabled = true;
            setStatus(NOT_REDDIT);
        } else setStatus(unreachable());
    } catch {
        // No active tab; the buttons will say so if used.
    }
}

pickButton.addEventListener("click", async () => {
    setStatus("");
    try {
        const result = await send({ type: "pick" });
        if (!result) return setStatus(unreachable());
        if (result.ok === false) return setStatus(`Picker failed: ${result.error}`);

        if (result.active) {
            window.close(); // get out of the way so the page can be clicked
        } else {
            setPicking(false);
            setStatus(result.hidden ? `Hid ${result.hidden}. Picking off.` : "Picking off.");
        }
    } catch {
        setStatus(NOT_RUNNING);
    }
});

document.getElementById("restoreAll").addEventListener("click", async () => {
    setStatus("");

    // Dropped outright and read back: a pick that survives is a storage problem.
    const { customRules: before = [] } = await api.storage.local.get({ customRules: [] });
    await api.storage.local.remove("customRules");
    await api.storage.local.set({ customRules: [] });
    const { customRules: after = [] } = await api.storage.local.get({ customRules: [] });

    const cleared = after.length === 0
        ? `Cleared ${before.length} saved pick${before.length === 1 ? "" : "s"}.`
        : `Warning: ${after.length} pick(s) would not clear.`;

    try {
        const result = await send({ type: "restoreAll" });
        if (!result) return setStatus(`${cleared} ${unreachable()}`);
        setStatus(result.restored
            ? `${cleared} Restored ${result.restored} on this page.`
            : `${cleared} No picks were showing on this page.`);
    } catch {
        setStatus(`${cleared} ${NOT_RUNNING}`);
    }
});

// Touch has no Esc and no ⌃⇧H; the picker shows its own Done button instead.
if (matchMedia("(hover: none) and (pointer: coarse)").matches) {
    document.querySelector(".hotkey").textContent = "Picking stays on until you tap Done.";
}

load();
