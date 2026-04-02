// Use absolute imports so the extension works when installed as a third-party repo (nested path depth differs).
import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '/script.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';

export { MODULE_NAME };

const MODULE_NAME = 'lore-diff';

const DEFAULT_SETTINGS = {
    profileMode: 'same', // 'same' | 'profile'
    profileId: null,
    maxMessages: 40,
    maxChars: 12000,
};

function ensureSettings() {
    if (!extension_settings.loreDiff) extension_settings.loreDiff = {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings.loreDiff[k] === undefined) extension_settings.loreDiff[k] = v;
    }
}

function getSupportedProfilesSafe() {
    try {
        return ConnectionManagerRequestService.getSupportedProfiles();
    } catch {
        return [];
    }
}

function getSelectedProfileIdByName(name) {
    const profiles = getSupportedProfilesSafe();
    return profiles.find(p => p.name === name)?.id ?? null;
}

function getChatProfileId() {
    // Connection Manager tracks the selected profile by name in its own settings.
    // If none is selected, return null to indicate "use current chat connection" (non-CM).
    const selected = extension_settings?.connectionManager?.selectedProfile ?? null;
    if (!selected || selected === '<None>') return null;
    return getSelectedProfileIdByName(selected);
}

function pickAnalysisProfileId() {
    if (extension_settings.loreDiff.profileMode === 'profile') {
        return extension_settings.loreDiff.profileId;
    }
    return getChatProfileId();
}

function setProfileRowVisibility() {
    const show = extension_settings.loreDiff.profileMode === 'profile';
    $('#lorediff_profile_row').toggleClass('hidden', !show);
}

function renderResults(result) {
    const $root = $('#lorediff_results');
    $root.empty();

    if (!result) {
        $root.text('No result.');
        return;
    }

    if (result.status === 'no_change') {
        $root.text('No relevant STATE changes detected.');
        return;
    }

    const items = Array.isArray(result.items) ? result.items : [];
    if (items.length === 0) {
        $root.text('No relevant STATE changes detected.');
        return;
    }

    for (const item of items) {
        const $item = $('<div class="lorediff_item"></div>');
        const $header = $('<div class="lorediff_item_header"></div>');
        $header.append($('<div class="lorediff_item_type"></div>').text(item.type ?? 'item'));
        $header.append($('<div class="lorediff_item_conf"></div>').text(item.confidence ?? ''));
        $item.append($header);
        $item.append($('<div></div>').text(item.label ?? ''));
        $item.append($('<div class="lorediff_item_reason"></div>').text(item.reason ?? ''));
        if (Array.isArray(item.evidence) && item.evidence.length) {
            const ev = item.evidence
                .map(e => (e?.quote ? `- ${e.quote}` : null))
                .filter(Boolean)
                .slice(0, 3)
                .join('\n');
            if (ev) $item.append($('<pre class="lorediff_item_reason"></pre>').text(ev));
        }
        $root.append($item);
    }
}

function safeJsonParse(text) {
    try {
        return JSON.parse(text);
    } catch {
        return null;
    }
}

function buildPrompt({ stateLore, chatSnippet }) {
    return [
        {
            role: 'system',
            content:
                'You are LoreDiff, a deterministic analyzer. Return ONLY valid JSON. No markdown. No extra keys.',
        },
        {
            role: 'user',
            content:
`Task: Compare the given baseline STATE lore with the recent chat snippet and detect ONLY meaningful persistent STATE changes.\n\nRules:\n- Human-in-the-middle: do not apply changes.\n- Only report if the chat introduces a NEW persistent fact, or CHANGES an existing persistent fact from baseline.\n- Ignore style, atmosphere, emotions, and transient dialogue.\n- If unsure, do NOT report.\n- Every item MUST include evidence quotes from the chat snippet.\n\nOutput JSON schema:\n{\n  \"status\": \"changes_detected\" | \"no_change\",\n  \"items\": [\n    {\n      \"type\": \"possible_state_change\" | \"new_entity\" | \"possible_relation_change\" | \"possible_location_change\" | \"possible_world_fact\",\n      \"label\": \"short label\",\n      \"confidence\": \"low\" | \"medium\" | \"high\",\n      \"reason\": \"short reason\",\n      \"evidence\": [ { \"quote\": \"short quote\" } ]\n    }\n  ]\n}\n\nBaseline STATE lore:\n${stateLore}\n\nRecent chat snippet:\n${chatSnippet}\n`,
        },
    ];
}

function truncateToChars(text, maxChars) {
    if (!text) return '';
    if (text.length <= maxChars) return text;
    return text.slice(text.length - maxChars);
}

function collectRecentChat(maxMessages, maxChars) {
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const messages = chat
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim().length)
        .slice(-maxMessages)
        .map(m => m.mes.trim());
    const joined = messages.join('\n\n');
    return truncateToChars(joined, maxChars);
}

async function collectStateLoreText() {
    // MVP: read loaded World Info entries that belong to book "STATE" (if available).
    // If we can't access it in this ST version, fall back to empty baseline (still works but less strict).
    const context = getContext();
    const wi = context?.worldInfo ?? context?.world_info ?? null;

    // Best-effort: support multiple shapes.
    const entries = wi?.entries ?? wi?.worldInfoEntries ?? wi?.data?.entries ?? null;
    if (!Array.isArray(entries)) return '';

    const stateEntries = entries.filter(e => e?.book === 'STATE' || e?.world === 'STATE');
    const blocks = stateEntries
        .map(e => {
            const title = e?.comment ? String(e.comment) : `uid:${e?.uid ?? ''}`;
            const content = e?.content ? String(e.content) : '';
            return `# ${title}\n${content}`.trim();
        })
        .filter(Boolean);
    return blocks.join('\n\n---\n\n');
}

async function runLoreDiff() {
    ensureSettings();

    const profileId = pickAnalysisProfileId();
    if (extension_settings.loreDiff.profileMode === 'profile' && !profileId) {
        renderResults({ status: 'no_change', items: [] });
        toastr?.warning?.('LoreDiff: Please select an analysis profile.');
        return;
    }

    const chatSnippet = collectRecentChat(extension_settings.loreDiff.maxMessages, extension_settings.loreDiff.maxChars);
    const stateLore = await collectStateLoreText();
    const messages = buildPrompt({ stateLore, chatSnippet });

    try {
        $('#lorediff_run_btn').prop('disabled', true);

        // If profileId is null: we currently don't have a stable public API to "use current chat connection"
        // from third-party code. For MVP we require Connection Manager and use its selected profile when in "same" mode.
        if (!profileId) {
            toastr?.error?.('LoreDiff: No active Connection Manager profile selected (set one, or choose a profile in LoreDiff settings).');
            return;
        }

        const extracted = await ConnectionManagerRequestService.sendRequest(profileId, messages, 512, { includeInstruct: true, includePreset: true });
        const rawText = extracted?.content ?? extracted?.data ?? extracted?.text ?? extracted?.message ?? '';
        const parsed = typeof rawText === 'string' ? safeJsonParse(rawText) : null;

        if (!parsed) {
            renderResults(null);
            toastr?.error?.('LoreDiff: Model did not return valid JSON.');
            return;
        }

        renderResults(parsed);
    } catch (err) {
        console.error('LoreDiff failed', err);
        toastr?.error?.('LoreDiff: Request failed. See console for details.');
    } finally {
        $('#lorediff_run_btn').prop('disabled', false);
    }
}

async function renderSettings() {
    ensureSettings();
    // Load settings.html relative to this module location.
    // This avoids relying on SillyTavern's `renderExtensionTemplateAsync`, which expects the extension
    // directory to be exactly `/scripts/extensions/<name>/...` (not always true for repo-based installs).
    const settingsUrl = new URL('./settings.html', import.meta.url);
    const html = await fetch(settingsUrl).then(r => {
        if (!r.ok) throw new Error(`LoreDiff: Failed to load settings template: ${r.status} ${r.statusText}`);
        return r.text();
    });
    $('#extensions_settings').append(html);

    const profiles = getSupportedProfilesSafe();
    const $profileSelect = $('#lorediff_profile_id');
    $profileSelect.empty();
    $profileSelect.append($('<option></option>').attr('value', '').text('— Select profile —'));
    for (const p of profiles) {
        $profileSelect.append($('<option></option>').attr('value', p.id).text(p.name ?? p.id));
    }

    $('#lorediff_profile_mode')
        .val(extension_settings.loreDiff.profileMode)
        .on('change', function () {
            extension_settings.loreDiff.profileMode = String($(this).val());
            setProfileRowVisibility();
            saveSettingsDebounced();
        });

    $('#lorediff_profile_id')
        .val(extension_settings.loreDiff.profileId ?? '')
        .on('change', function () {
            extension_settings.loreDiff.profileId = String($(this).val()) || null;
            saveSettingsDebounced();
        });

    $('#lorediff_max_messages')
        .val(extension_settings.loreDiff.maxMessages)
        .on('input', function () {
            extension_settings.loreDiff.maxMessages = Number($(this).val()) || DEFAULT_SETTINGS.maxMessages;
            saveSettingsDebounced();
        });

    $('#lorediff_max_chars')
        .val(extension_settings.loreDiff.maxChars)
        .on('input', function () {
            extension_settings.loreDiff.maxChars = Number($(this).val()) || DEFAULT_SETTINGS.maxChars;
            saveSettingsDebounced();
        });

    $('#lorediff_run_btn').on('click', runLoreDiff);
    setProfileRowVisibility();
}

function registerSlashCommand() {
    const cmd = SlashCommand.fromProps({
        name: 'lorediff',
        callback: async () => {
            await runLoreDiff();
            return '';
        },
        helpString: 'Detect STATE changes (LoreDiff)',
    });
    cmd.isThirdParty = true;
    cmd.source = 'LoreDiff';
    SlashCommandParser.addCommandObject(cmd);
}

// Init
eventSource.on(event_types.APP_READY, async () => {
    ensureSettings();
    await renderSettings();
    registerSlashCommand();
});
