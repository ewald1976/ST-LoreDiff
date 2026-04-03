// Use absolute imports so the extension works when installed as a third-party repo (nested path depth differs).
import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '/script.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { checkWorldInfo } from '/scripts/world-info.js';

export { MODULE_NAME };

const MODULE_NAME = 'lore-diff';

const DEFAULT_SETTINGS = {
    profileMode: 'same', // 'same' | 'profile'
    profileId: null,
    maxMessages: 40,
    maxChars: 12000,
    jsonMode: 'tolerant', // 'tolerant' | 'strict'
    baselineBook: 'STATE', // 'STATE' | 'WORLD'
    promptProfileId: 'default',
    promptProfiles: [],
};

function ensureSettings() {
    if (!extension_settings.loreDiff) extension_settings.loreDiff = {};
    for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) {
        if (extension_settings.loreDiff[k] === undefined) extension_settings.loreDiff[k] = v;
    }

    // Seed prompt profiles if missing.
    if (!Array.isArray(extension_settings.loreDiff.promptProfiles) || extension_settings.loreDiff.promptProfiles.length === 0) {
        extension_settings.loreDiff.promptProfiles = [
            {
                id: 'default',
                name: 'Default',
                template: buildDefaultPromptTemplate(),
            },
        ];
    }

    // Ensure selected prompt profile exists.
    const selectedId = extension_settings.loreDiff.promptProfileId ?? 'default';
    if (!extension_settings.loreDiff.promptProfiles.some(p => p?.id === selectedId)) {
        extension_settings.loreDiff.promptProfileId = extension_settings.loreDiff.promptProfiles[0]?.id ?? 'default';
    }
}

function buildDefaultPromptTemplate() {
    return (
`Task: Compare the given baseline {{baselineBook}} lore with the recent chat snippet and detect ONLY meaningful persistent STATE changes.

Rules:
- Human-in-the-middle: do not apply changes.
- Only report if the chat introduces a NEW persistent fact, or CHANGES an existing persistent fact from baseline.
- Ignore style, atmosphere, emotions, and transient dialogue.
- If unsure, do NOT report.

- Do NOT infer internal thoughts, intentions, or emotional states unless explicitly stated as persistent facts.
- Internal thoughts or reflections are NOT persistent facts unless they result in an explicit, externally observable change.
- Do NOT treat narrated or possibly unreliable past events as persistent facts unless clearly established as true.

- Distinguish strictly:
  - "possible_location_change" = a character physically moves location.
  - "possible_world_fact" = a location is introduced or described.

- A fact is persistent ONLY if it remains true beyond the current scene.

Output rules:
- Return ONLY valid JSON.
- Do NOT use markdown.
- Do NOT add any text before or after the JSON.
- Keep output short and simple.
- Return at most 3 items.
- Use exactly 1 short evidence quote per item.
- Labels must be short (max 6 words).
- Reasons must be one short sentence.

If no changes are found, return exactly:
{"status":"no_change","items":[]}

Output JSON schema:
{
  "status": "changes_detected" | "no_change",
  "items": [
    {
      "type": "possible_state_change" | "new_entity" | "possible_relation_change" | "possible_location_change" | "possible_world_fact",
      "label": "short label",
      "confidence": "low" | "medium" | "high",
      "reason": "short reason",
      "evidence": [ { "quote": "short quote" } ]
    }
  ]
}

Baseline {{baselineBook}} lore:
{{stateLore}}

Recent chat snippet:
{{chatSnippet}}
`
    );
}

function getPromptProfiles() {
    const list = extension_settings?.loreDiff?.promptProfiles;
    return Array.isArray(list) ? list : [];
}

function getSelectedPromptProfile() {
    const id = extension_settings?.loreDiff?.promptProfileId;
    return getPromptProfiles().find(p => p?.id === id) ?? getPromptProfiles()[0] ?? null;
}

function renderPromptProfileOptions() {
    const profiles = getPromptProfiles();
    const $sel = $('#lorediff_prompt_profile');
    if ($sel.length === 0) return;

    $sel.empty();
    for (const p of profiles) {
        $sel.append($('<option></option>').attr('value', p.id).text(p.name ?? p.id));
    }
    $sel.val(extension_settings.loreDiff.promptProfileId);
}

function updatePromptEditorFromSelection() {
    const p = getSelectedPromptProfile();
    $('#lorediff_prompt_template').val(p?.template ?? '');
    $('#lorediff_prompt_profile_name').val(p?.name ?? '');
}

function makeId() {
    return `p_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
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

    const profiles = getSupportedProfilesSafe();
    // In some setups the profiles list may not be populated yet when this code runs.
    // If we have a selectedProfile value, treat it as an ID fallback.
    if (!Array.isArray(profiles) || profiles.length === 0) return selected;

    // Some ST versions store selectedProfile as an ID; others store it as a name.
    const byId = profiles.find(p => p.id === selected)?.id ?? null;
    if (byId) return byId;

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

function stripCodeFences(text) {
    if (typeof text !== 'string') return '';
    const trimmed = text.trim();
    // Remove triple-backtick fences if present
    if (trimmed.startsWith('```')) {
        return trimmed.replace(/^```[a-zA-Z0-9_-]*\s*/m, '').replace(/```$/m, '').trim();
    }
    return trimmed;
}

function tryRepairJsonString(text) {
    if (typeof text !== 'string') return '';
    let s = text.trim();
    // Remove BOM
    s = s.replace(/^\uFEFF/, '');
    // Remove trailing commas before } or ]
    s = s.replace(/,\s*([}\]])/g, '$1');
    return s;
}

function extractFirstJson(text) {
    if (typeof text !== 'string') return null;
    const s = stripCodeFences(text);
    const start = Math.min(
        ...[s.indexOf('{'), s.indexOf('[')].filter(i => i >= 0),
    );
    if (!Number.isFinite(start) || start < 0) return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    let end = -1;

    for (let i = start; i < s.length; i++) {
        const ch = s[i];

        if (inString) {
            if (escaped) {
                escaped = false;
                continue;
            }
            if (ch === '\\') {
                escaped = true;
                continue;
            }
            if (ch === '"') {
                inString = false;
            }
            continue;
        }

        if (ch === '"') {
            inString = true;
            continue;
        }

        if (ch === '{' || ch === '[') depth++;
        if (ch === '}' || ch === ']') depth--;

        if (depth === 0) {
            end = i + 1;
            break;
        }
    }

    if (end <= start) return null;
    return s.slice(start, end);
}

function parseModelJson(rawText) {
    if (typeof rawText !== 'string') return { parsed: null, raw: '' };
    const raw = rawText;

    if (extension_settings.loreDiff.jsonMode === 'strict') {
        return { parsed: safeJsonParse(stripCodeFences(raw)), raw };
    }

    // tolerant mode: try direct parse, then extract, then repair
    const direct = safeJsonParse(stripCodeFences(raw));
    if (direct) return { parsed: direct, raw };

    const extracted = extractFirstJson(raw);
    if (!extracted) return { parsed: null, raw };

    const repaired = tryRepairJsonString(extracted);
    return { parsed: safeJsonParse(repaired), raw };
}

function substituteTemplate(template, vars) {
    if (typeof template !== 'string') return '';
    let out = template;
    for (const [k, v] of Object.entries(vars)) {
        out = out.replaceAll(`{{${k}}}`, v ?? '');
    }
    return out;
}

function buildPrompt({ stateLore, chatSnippet }) {
    const selected = getSelectedPromptProfile();
    const template = selected?.template || buildDefaultPromptTemplate();
    const content = substituteTemplate(template, {
        stateLore,
        chatSnippet,
        baselineBook: extension_settings?.loreDiff?.baselineBook ?? 'STATE',
    });

    return [
        {
            role: 'system',
            content:
                'You are LoreDiff, a deterministic analyzer. Return ONLY valid JSON. No markdown. No extra keys.',
        },
        {
            role: 'user',
            content,
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
    // Use SillyTavern's own World Info scan engine (dry run) and then take only activated entries
    // from the selected lorebook (STATE/WORLD).
    // This is robust across ST versions and keeps the baseline small (only relevant entries for the recent chat).
    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const recent = chat
        .filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim().length)
        .slice(-extension_settings.loreDiff.maxMessages)
        .map(m => m.mes.trim())
        .reverse();

    if (recent.length === 0) return '';

    try {
        // maxContext controls WI budget; use a typical local-model context here.
        const maxContext = 8192;
        const activated = await checkWorldInfo(recent, maxContext, true);
        const activatedEntries = Array.from(activated?.allActivatedEntries ?? []);
        const baselineBook = extension_settings?.loreDiff?.baselineBook ?? 'STATE';
        const selectedEntries = activatedEntries.filter(e => e?.book === baselineBook);
        const blocks = selectedEntries
            .map(e => {
                const title = e?.comment ? String(e.comment) : `uid:${e?.uid ?? ''}`;
                const content = e?.content ? String(e.content) : '';
                return `# ${title}\n${content}`.trim();
            })
            .filter(Boolean);
        return blocks.join('\n\n---\n\n');
    } catch (err) {
        console.warn('LoreDiff: Failed to collect STATE baseline via checkWorldInfo()', err);
        return '';
    }
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
        const { parsed, raw } = parseModelJson(typeof rawText === 'string' ? rawText : String(rawText ?? ''));

        if (!parsed) {
            renderResults(null);
            // Show raw output to help debugging "wild" models.
            const $root = $('#lorediff_results');
            $root.append($('<div></div>').text('Model output (raw):'));
            $root.append($('<pre class="lorediff_item_reason"></pre>').text(raw));
            toastr?.error?.('LoreDiff: Could not parse JSON from model output.');
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

    $('#lorediff_baseline_book')
        .val(extension_settings.loreDiff.baselineBook)
        .on('change', function () {
            extension_settings.loreDiff.baselineBook = String($(this).val());
            saveSettingsDebounced();
        });

    $('#lorediff_max_chars')
        .val(extension_settings.loreDiff.maxChars)
        .on('input', function () {
            extension_settings.loreDiff.maxChars = Number($(this).val()) || DEFAULT_SETTINGS.maxChars;
            saveSettingsDebounced();
        });

    $('#lorediff_json_mode')
        .val(extension_settings.loreDiff.jsonMode)
        .on('change', function () {
            extension_settings.loreDiff.jsonMode = String($(this).val());
            saveSettingsDebounced();
        });

    // Prompt profile UI
    renderPromptProfileOptions();
    updatePromptEditorFromSelection();

    $('#lorediff_prompt_profile')
        .val(extension_settings.loreDiff.promptProfileId)
        .on('change', function () {
            extension_settings.loreDiff.promptProfileId = String($(this).val());
            updatePromptEditorFromSelection();
            saveSettingsDebounced();
        });

    $('#lorediff_prompt_profile_name')
        .val(getSelectedPromptProfile()?.name ?? '')
        .on('input', function () {
            const p = getSelectedPromptProfile();
            if (!p) return;
            p.name = String($(this).val());
            renderPromptProfileOptions();
            saveSettingsDebounced();
        });

    $('#lorediff_prompt_template')
        .val(getSelectedPromptProfile()?.template ?? '')
        .on('input', function () {
            const p = getSelectedPromptProfile();
            if (!p) return;
            p.template = String($(this).val());
            saveSettingsDebounced();
        });

    $('#lorediff_prompt_new').on('click', function () {
        const id = makeId();
        extension_settings.loreDiff.promptProfiles.push({
            id,
            name: 'New Prompt',
            template: buildDefaultPromptTemplate(),
        });
        extension_settings.loreDiff.promptProfileId = id;
        renderPromptProfileOptions();
        updatePromptEditorFromSelection();
        saveSettingsDebounced();
    });

    $('#lorediff_prompt_duplicate').on('click', function () {
        const src = getSelectedPromptProfile();
        if (!src) return;
        const id = makeId();
        extension_settings.loreDiff.promptProfiles.push({
            id,
            name: `${src.name ?? 'Prompt'} (Copy)`,
            template: src.template ?? '',
        });
        extension_settings.loreDiff.promptProfileId = id;
        renderPromptProfileOptions();
        updatePromptEditorFromSelection();
        saveSettingsDebounced();
    });

    $('#lorediff_prompt_delete').on('click', function () {
        const id = extension_settings.loreDiff.promptProfileId;
        const list = getPromptProfiles();
        if (list.length <= 1) {
            toastr?.warning?.('LoreDiff: At least one prompt profile must exist.');
            return;
        }
        const idx = list.findIndex(p => p?.id === id);
        if (idx >= 0) list.splice(idx, 1);
        extension_settings.loreDiff.promptProfileId = list[0]?.id ?? 'default';
        renderPromptProfileOptions();
        updatePromptEditorFromSelection();
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
