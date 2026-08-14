//
//  popup.js
//  Toggles are written to storage.local; the content script watches for the
//  change and applies or undoes the rule live, so nothing needs reloading.
//

const api = globalThis.browser ?? globalThis.chrome;

const RULE_IDS = ["loginWall", "sidebarLoginPrompt", "peopleAlsoAsk"];
const DEFAULTS = { ...Object.fromEntries(RULE_IDS.map((id) => [id, true])), customRules: [] };

const NOT_RUNNING =
    "Not running here — open a Reddit page and allow the extension on reddit.com.";

const UNREACHABLE = "Could not reach this page. Reload it (⌘R) and try again.";

const statusEl = document.getElementById("status");
const pickButton = document.getElementById("pick");

const setStatus = (text) => { statusEl.textContent = text; };
const setPicking = (active) => { pickButton.textContent = active ? "Stop picking" : "Pick element"; };

// Talk to the page, and repair it if nobody answers. A tab loaded before the
// extension was rebuilt runs a stale content script (or none at all, if the
// permission was granted after load); rather than asking the user to reload,
// inject the current scripts and ask again. Injection over an existing copy is
// harmless — the content script detects itself and takes over.
// Why the last send() could not reach the page, for the status line.
let lastFailure = "";

async function send(message) {
    lastFailure = "";
    const [tab] = await api.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("no active tab");

    const ask = () => api.tabs.sendMessage(tab.id, message).catch(() => undefined);

    let result = await ask();
    if (result !== undefined) return result;

    // Nobody answered: inject the current scripts and ask again.
    if (!api.scripting) {
        // The permission was added after this extension was last approved.
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
    result = await ask();
    if (result === undefined) lastFailure = "injected, but the page did not answer";
    return result;
}

const unreachable = () =>
    lastFailure ? `Could not reach this page: ${lastFailure}` : UNREACHABLE;

async function load() {
    const settings = await api.storage.local.get(DEFAULTS);

    for (const id of RULE_IDS) {
        const input = document.getElementById(id);
        input.checked = settings[id] !== false;
        input.addEventListener("change", () => {
            api.storage.local.set({ [id]: input.checked });
            setStatus(input.checked ? "Rule on." : "Rule off — items restored.");
        });
    }

    // Reflect whether picking is already running in this tab, and surface a
    // stale content script before the user hits a button that silently no-ops.
    try {
        const status = await send({ type: "status" });
        if (!status) setStatus(unreachable());
        else setPicking(status.picking);
    } catch {
        // Not a Reddit tab; the buttons will say so if used.
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

// Unstick everything on the page, whatever hid it, and drop every stored pick.
document.getElementById("restoreAll").addEventListener("click", async () => {
    setStatus("");

    // Drop the key outright rather than overwriting it, then read it back:
    // a pick that survives this is a storage problem, not a page problem, and
    // the count says which it was.
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

// No re-scan button: the content script already sweeps on every mutation, on
// scroll, on route change and on a retry ladder after load, so a manual scan
// can only repeat what has already happened. The message handler is still there
// for `__redditLoginBypass__.sweep()` from the console.

load();
