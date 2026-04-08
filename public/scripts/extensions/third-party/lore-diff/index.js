// Use absolute imports so the extension works when installed as a third-party repo (nested path depth differs).
import { extension_settings, getContext } from '/scripts/extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '/script.js';
import { SlashCommand } from '/scripts/slash-commands/SlashCommand.js';
import { SlashCommandParser } from '/scripts/slash-commands/SlashCommandParser.js';
import { ConnectionManagerRequestService } from '/scripts/extensions/shared.js';
import { checkWorldInfo, worldInfoCache, getWorldInfoSettings, world_names } from '/scripts/world-info.js';
import { POPUP_TYPE, callGenericPopup } from '/scripts/popup.js';
import { copyText } from '/scripts/utils.js';

export { MODULE_NAME };

const MODULE_NAME = 'lore-diff';

const DEFAULT_SETTINGS = {
    requestMode: 'st', // 'st' | 'external'
    profileMode: 'same', // 'same' | 'profile'
    profileId: null,
    maxMessages: 40,
    maxTokens: 600,
    maxChars: 12000,
    jsonMode: 'tolerant', // 'tolerant' | 'strict'
    baselineBook: 'STATE', // arbitrary lorebook/book name (e.g. STATE, WORLD, RELATIONS)
    // Legacy delta prompt profiles (kept for now)
    promptProfileId: 'default',
    promptProfiles: [],
    // New: Story/Scene extraction prompt profiles
    storyPromptProfileId: 'default',
    storyPromptProfiles: [],
    scenePromptProfileId: 'default',
    scenePromptProfiles: [],
    externalApiBaseUrl: '',
    externalApiKey: '',
    externalModel: '',
    externalTemperature: 0.3,
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

    // Seed STORY_STATE profiles if missing.
    if (!Array.isArray(extension_settings.loreDiff.storyPromptProfiles) || extension_settings.loreDiff.storyPromptProfiles.length === 0) {
        extension_settings.loreDiff.storyPromptProfiles = [
            {
                id: 'default',
                name: 'Default',
                template: buildStoryStatePromptTemplate(),
            },
        ];
    }
    const storyId = extension_settings.loreDiff.storyPromptProfileId ?? 'default';
    if (!extension_settings.loreDiff.storyPromptProfiles.some(p => p?.id === storyId)) {
        extension_settings.loreDiff.storyPromptProfileId = extension_settings.loreDiff.storyPromptProfiles[0]?.id ?? 'default';
    }

    // Seed SCENE STATE profiles if missing.
    if (!Array.isArray(extension_settings.loreDiff.scenePromptProfiles) || extension_settings.loreDiff.scenePromptProfiles.length === 0) {
        extension_settings.loreDiff.scenePromptProfiles = [
            {
                id: 'default',
                name: 'Default',
                template: buildSceneStatePromptTemplate(),
            },
        ];
    }
    const sceneId = extension_settings.loreDiff.scenePromptProfileId ?? 'default';
    if (!extension_settings.loreDiff.scenePromptProfiles.some(p => p?.id === sceneId)) {
        extension_settings.loreDiff.scenePromptProfileId = extension_settings.loreDiff.scenePromptProfiles[0]?.id ?? 'default';
    }

    // Migrate legacy default SCENE prompt that echoed static sections (constraints/narrative_mode).
    // Only touches the `default` profile and only if it still contains the old static blocks.
    const defaultScene = extension_settings.loreDiff.scenePromptProfiles.find(p => p?.id === 'default');
    if (defaultScene?.template && typeof defaultScene.template === 'string') {
        const shouldUpdateDefaultScene =
            // old static blocks (echo-prone)
            (defaultScene.template.includes('\n  constraints:\n') && defaultScene.template.includes('\n  narrative_mode:\n')) ||
            // older trimmed prompt without these fields at all
            (!defaultScene.template.includes('\n  constraints:') && !defaultScene.template.includes('\n  narrative_mode:'));

        if (shouldUpdateDefaultScene) {
            defaultScene.template = buildSceneStatePromptTemplate();
        }
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

function buildStoryStatePromptTemplate() {
    return (
`You are a STRICT STORY STATE EXTRACTOR.

Your task is to extract ONLY explicit long-term story-relevant information from the provided material.

SOURCE PRIORITY:
1. Recent chat snippet
2. Scene summary
3. Baseline STATE lore = context only

CRITICAL RULES:
- Do NOT explain anything
- Do NOT add interpretation beyond the text
- Do NOT infer motives, history, symbolism, or hidden meaning
- Do NOT generalize
- Keep everything short and concrete
- Maximum 5 items per section
- If unsure, leave it out
- Empty fields are valid
- Use baseline STATE lore only to understand context, never to invent new story elements

VERY IMPORTANT:
- If no explicit mission or goal is stated in the chat snippet or summary, set active_mission to ""
- Do NOT create a mission from general conversation alone
- Do NOT convert atmosphere, hospitality, weather, or casual actions into discoveries unless they clearly matter to the ongoing story
- Do NOT repeat stable background facts unless they became newly relevant in this scene

OUTPUT FORMAT:

STORY_STATE:
  active_mission: "<short sentence or empty>"

  discoveries:
    - "<new long-term fact from this scene>"

  tensions:
    - "<ongoing conflict, risk, or unresolved pressure explicitly present>"

  notes:
    - "<optional subtle but explicit observation>"

If you find nothing worth mentioning, say so.
---

INPUT SUMMARY:
{{SUMMARY}}

BASELINE STATE LORE:
{{stateLore}}

RECENT CHAT SNIPPET:
{{chatSnippet}}

---
OUTPUT:
`
    );
}

function buildSceneStatePromptTemplate() {
    return (
`You are a STRICT SCENE STATE EXTRACTOR.

Your task is to extract ONLY the current scene state from the provided material.

SOURCE PRIORITY:
1. Recent chat snippet
2. Scene summary
3. Baseline STATE lore = context only

CRITICAL RULES:
- Do NOT explain anything
- Do NOT add interpretation beyond the text
- Do NOT infer emotions unless clearly shown or stated
- Keep everything short and concrete
- Empty fields are valid
- Use baseline STATE lore only to understand context, never to invent new scene details

OUTPUT FORMAT:

STATE:
  location: "<explicit location or empty>"
  time: "<explicit time, or morning/afternoon/evening/night, or empty>"
  atmosphere: "<brief explicit atmosphere or empty>"
  situation: "<brief explicit current situation>"

  constraints: []
  narrative_mode: []

  notes:
    - "<optional explicit scene-relevant note>"  # use [] if none

FORMAT RULES:
- Always include "constraints" and "narrative_mode" fields.
- If none are explicitly stated in the text, output an empty list: []
- Do NOT copy prompt text. Only output items grounded in the provided material.

---

INPUT SUMMARY:
{{SUMMARY}}

BASELINE STATE LORE:
{{stateLore}}

RECENT CHAT SNIPPET:
{{chatSnippet}}

---

OUTPUT:
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

function getAvailableLorebooks() {
    // Best-effort: derive lorebook/book names from loaded world info data.
    // Goal: surface custom books like RELATIONS, etc., even if not currently activated.
    const books = new Set();

    try {
        if (Array.isArray(world_names) && world_names.length) {
            for (const n of world_names) {
                if (n) books.add(String(n));
            }
        }

        // Prefer settings (contains all loaded WI, not only cached/activated).
        const settings = typeof getWorldInfoSettings === 'function' ? getWorldInfoSettings() : null;
        const worldInfoObj = settings?.world_info;
        if (worldInfoObj && typeof worldInfoObj === 'object') {
            for (const name of Object.keys(worldInfoObj)) {
                if (name && name !== 'globalSelect') books.add(String(name));
            }
        }

        const keys = typeof worldInfoCache?.keys === 'function' ? Array.from(worldInfoCache.keys()) : [];
        for (const k of keys) {
            const wi = worldInfoCache.get(k);
            const entries = wi?.entries;
            if (Array.isArray(entries)) {
                for (const e of entries) {
                    if (e?.book) books.add(String(e.book));
                }
            }
            // Some data shapes include books as an object map.
            const wiBooks = wi?.books;
            if (wiBooks && typeof wiBooks === 'object') {
                for (const b of Object.keys(wiBooks)) books.add(String(b));
            }
        }
    } catch (err) {
        console.warn('LoreDiff: Failed to enumerate lorebooks from worldInfoCache', err);
    }

    // Fallback to common defaults.
    if (books.size === 0) {
        books.add('STATE');
        books.add('WORLD');
    }

    return Array.from(books).sort((a, b) => a.localeCompare(b));
}

function renderBaselineBookOptions() {
    const $sel = $('#lorediff_baseline_book');
    if ($sel.length === 0) return;

    const books = getAvailableLorebooks();
    $sel.empty();
    for (const b of books) {
        $sel.append($('<option></option>').attr('value', b).text(b));
    }

    const current = extension_settings?.loreDiff?.baselineBook ?? 'STATE';
    if (!books.includes(current)) {
        $sel.append($('<option></option>').attr('value', current).text(current));
    }
    $sel.val(current);
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

function isExternalMode() {
    return extension_settings?.loreDiff?.requestMode === 'external';
}

function setConnectionControlsVisibility() {
    const external = isExternalMode();
    $('#lorediff_profile_mode').closest('.flex-container').toggleClass('hidden', external);
    $('#lorediff_profile_row').toggleClass('hidden', external || extension_settings.loreDiff.profileMode !== 'profile');
    $('#lorediff_external_block').toggleClass('hidden', !external);
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

function normalizeBaseUrl(url) {
    const s = String(url ?? '').trim();
    return s.replace(/\/+$/, '');
}

async function testExternalConnection() {
    const baseUrl = normalizeBaseUrl(extension_settings?.loreDiff?.externalApiBaseUrl);
    const apiKey = String(extension_settings?.loreDiff?.externalApiKey ?? '');
    if (!baseUrl) {
        toastr?.error?.('LoreDiff: External API base URL is missing.');
        return;
    }

    const url = `${baseUrl}/models`;
    try {
        const res = await fetch(url, {
            method: 'GET',
            headers: {
                ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
            },
        });
        const text = await res.text();
        if (!res.ok) {
            throw new Error(`${res.status} ${res.statusText}: ${text.slice(0, 300)}`);
        }
        let data = null;
        try { data = JSON.parse(text); } catch { /* ignore */ }
        const count = Array.isArray(data?.data) ? data.data.length : null;
        toastr?.success?.(`LoreDiff: Connection OK${typeof count === 'number' ? ` (${count} models)` : ''}.`);
    } catch (err) {
        console.error('LoreDiff external connection test failed', err);
        toastr?.error?.(`LoreDiff: Connection failed (${String(err?.message ?? err)})`);
    }
}

async function sendExternalChatCompletion(messages, maxTokens) {
    const baseUrl = normalizeBaseUrl(extension_settings?.loreDiff?.externalApiBaseUrl);
    const apiKey = String(extension_settings?.loreDiff?.externalApiKey ?? '');
    const model = String(extension_settings?.loreDiff?.externalModel ?? '').trim();
    const temperature = Number(extension_settings?.loreDiff?.externalTemperature ?? 0.3);

    if (!baseUrl) throw new Error('LoreDiff: External API base URL is missing.');
    if (!model) throw new Error('LoreDiff: External model is missing.');

    const url = `${baseUrl}/chat/completions`;
    const res = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            ...(apiKey ? { 'Authorization': `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
            model,
            messages,
            stream: false,
            max_tokens: maxTokens,
            temperature,
        }),
    });

    const text = await res.text();
    if (!res.ok) {
        throw new Error(`LoreDiff: External API error ${res.status}: ${text.slice(0, 500)}`);
    }

    let data;
    try { data = JSON.parse(text); } catch { data = null; }
    if (!data) {
        throw new Error('LoreDiff: External API returned non-JSON response.');
    }

    const choice = Array.isArray(data.choices) ? data.choices[0] : null;
    const content =
        choice?.message?.content ??
        choice?.delta?.content ??
        choice?.text ??
        '';
    return String(content ?? '');
}

async function sendAnalysisRequest(messages, maxTokens) {
    if (isExternalMode()) {
        const content = await sendExternalChatCompletion(messages, maxTokens);
        return { content };
    }

    const profileId = pickAnalysisProfileId();
    if (!profileId) {
        throw new Error('LoreDiff: No active Connection Manager profile selected (set one, or choose a profile in LoreDiff settings).');
    }
    return await ConnectionManagerRequestService.sendRequest(profileId, messages, maxTokens, { includeInstruct: true, includePreset: true });
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

    const chatSnippet = collectRecentChat(extension_settings.loreDiff.maxMessages, extension_settings.loreDiff.maxChars);
    const stateLore = await collectStateLoreText();
    const messages = buildPrompt({ stateLore, chatSnippet });

    try {
        $('#lorediff_run_btn').prop('disabled', true);
        const extracted = await sendAnalysisRequest(messages, extension_settings.loreDiff.maxTokens);
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

function formatDetectedItems(result) {
    const items = Array.isArray(result?.items) ? result.items : [];
    if (!items.length) return 'No relevant changes detected.';

    const groups = new Map();
    for (const it of items) {
        const type = String(it?.type ?? 'item');
        if (!groups.has(type)) groups.set(type, []);
        groups.get(type).push(it);
    }

    const lines = [];
    for (const [type, list] of groups.entries()) {
        lines.push(type.toUpperCase());
        for (const it of list) {
            const label = String(it?.label ?? '').trim();
            const conf = String(it?.confidence ?? '').trim();
            const confStr = conf ? ` (${conf})` : '';
            lines.push(`- ${label}${confStr}`.trim());
        }
        lines.push('');
    }
    return lines.join('\n').trim();
}

async function detectChangesOnce() {
    ensureSettings();

    const chatSnippet = collectRecentChat(extension_settings.loreDiff.maxMessages, extension_settings.loreDiff.maxChars);
    const stateLore = await collectStateLoreText();
    const messages = buildPrompt({ stateLore, chatSnippet });
    const extracted = await sendAnalysisRequest(messages, extension_settings.loreDiff.maxTokens);
    const rawText = extracted?.content ?? extracted?.data ?? extracted?.text ?? extracted?.message ?? '';
    return parseModelJson(typeof rawText === 'string' ? rawText : String(rawText ?? ''));
}

async function generateLoreSuggestion(stateLore, chatSnippet) {
    ensureSettings();

    const baseUserPrompt = buildPrompt({ stateLore, chatSnippet })?.find(m => m?.role === 'user')?.content ?? '';
    const prompt = [
        {
            role: 'system',
            content: 'You are LoreDiff. Follow instructions exactly.',
        },
        {
            role: 'user',
            content:
`${baseUserPrompt}

Generate a structured lore suggestion.

Rules:
- Only include meaningful, persistent changes.
- Use short, neutral sentences.
- No dialogue.
- No speculation.
- Keep it compact.

Format:

[Lorevorschlag]

STATE
- ...

ABILITY
- ...

RELATION
- ...
`,
        },
    ];

    const extracted = await sendAnalysisRequest(prompt, extension_settings.loreDiff.maxTokens);
    const rawText = extracted?.content ?? extracted?.data ?? extracted?.text ?? extracted?.message ?? '';
    return typeof rawText === 'string' ? rawText.trim() : String(rawText ?? '').trim();
}

function getStoryProfiles() {
    const list = extension_settings?.loreDiff?.storyPromptProfiles;
    return Array.isArray(list) ? list : [];
}

function getSceneProfiles() {
    const list = extension_settings?.loreDiff?.scenePromptProfiles;
    return Array.isArray(list) ? list : [];
}

function getSelectedStoryProfile() {
    const id = extension_settings?.loreDiff?.storyPromptProfileId;
    return getStoryProfiles().find(p => p?.id === id) ?? getStoryProfiles()[0] ?? null;
}

function getSelectedSceneProfile() {
    const id = extension_settings?.loreDiff?.scenePromptProfileId;
    return getSceneProfiles().find(p => p?.id === id) ?? getSceneProfiles()[0] ?? null;
}

function renderModalPromptDropdown($sel, profiles, selectedId) {
    $sel.empty();
    for (const p of profiles) {
        $sel.append($('<option></option>').attr('value', p.id).text(p.name ?? p.id));
    }
    $sel.val(selectedId);
}

function ensureAtLeastOnePrompt(list, kindLabel) {
    if (list.length > 0) return true;
    toastr?.error?.(`LoreDiff: No ${kindLabel} prompt profiles available.`);
    return false;
}

function createNewPromptProfile(kind) {
    const id = makeId();
    const entry = {
        id,
        name: 'New Prompt',
        template: kind === 'story' ? buildStoryStatePromptTemplate() : buildSceneStatePromptTemplate(),
    };
    if (kind === 'story') {
        extension_settings.loreDiff.storyPromptProfiles.push(entry);
        extension_settings.loreDiff.storyPromptProfileId = id;
    } else {
        extension_settings.loreDiff.scenePromptProfiles.push(entry);
        extension_settings.loreDiff.scenePromptProfileId = id;
    }
    saveSettingsDebounced();
}

function duplicatePromptProfile(kind) {
    const src = kind === 'story' ? getSelectedStoryProfile() : getSelectedSceneProfile();
    if (!src) return;
    const id = makeId();
    const entry = {
        id,
        name: `${src.name ?? 'Prompt'} (Copy)`,
        template: src.template ?? '',
    };
    if (kind === 'story') {
        extension_settings.loreDiff.storyPromptProfiles.push(entry);
        extension_settings.loreDiff.storyPromptProfileId = id;
    } else {
        extension_settings.loreDiff.scenePromptProfiles.push(entry);
        extension_settings.loreDiff.scenePromptProfileId = id;
    }
    saveSettingsDebounced();
}

function deletePromptProfile(kind) {
    const list = kind === 'story' ? getStoryProfiles() : getSceneProfiles();
    if (list.length <= 1) {
        toastr?.warning?.('LoreDiff: At least one prompt profile must exist.');
        return;
    }
    const selectedId = kind === 'story' ? extension_settings.loreDiff.storyPromptProfileId : extension_settings.loreDiff.scenePromptProfileId;
    const idx = list.findIndex(p => p?.id === selectedId);
    if (idx >= 0) list.splice(idx, 1);
    const nextId = list[0]?.id ?? 'default';
    if (kind === 'story') extension_settings.loreDiff.storyPromptProfileId = nextId;
    else extension_settings.loreDiff.scenePromptProfileId = nextId;
    saveSettingsDebounced();
}

async function runTextExtraction({ kind, summary, stateLore, chatSnippet }) {
    ensureSettings();
    const baselineBook = extension_settings?.loreDiff?.baselineBook ?? 'STATE';

    const profile =
        kind === 'story'
            ? (getSelectedStoryProfile() ?? { template: buildStoryStatePromptTemplate() })
            : (getSelectedSceneProfile() ?? { template: buildSceneStatePromptTemplate() });

    const template = profile?.template ?? '';
    const promptText = substituteTemplate(template, {
        SUMMARY: summary ?? '',
        stateLore,
        chatSnippet,
        baselineBook,
    });

    const messages = [
        { role: 'system', content: 'Follow the instructions exactly. Output only the requested format.' },
        { role: 'user', content: promptText },
    ];

    const extracted = await sendAnalysisRequest(messages, extension_settings.loreDiff.maxTokens);
    const rawText = extracted?.content ?? extracted?.data ?? extracted?.text ?? extracted?.message ?? '';
    return typeof rawText === 'string' ? rawText.trim() : String(rawText ?? '').trim();
}

async function openLoreDiffModal() {
    ensureSettings();

    const modalUrl = new URL('./modal.html', import.meta.url);
    const html = await fetch(modalUrl).then(r => {
        if (!r.ok) throw new Error(`LoreDiff: Failed to load modal template: ${r.status} ${r.statusText}`);
        return r.text();
    });

    const $dialog = $(html);
    const baselineBook = extension_settings?.loreDiff?.baselineBook ?? 'STATE';
    $dialog.find('#lorediff_modal_lorebook').text(baselineBook);

    const context = getContext();
    const chat = Array.isArray(context?.chat) ? context.chat : [];
    const nonSystem = chat.filter(m => m && !m.is_system && typeof m.mes === 'string' && m.mes.trim().length);
    const maxMessages = extension_settings?.loreDiff?.maxMessages ?? 40;
    const startIdx = Math.max(0, nonSystem.length - maxMessages);
    const endIdx = Math.max(0, nonSystem.length - 1);
    $dialog.find('#lorediff_modal_range').text(`#${startIdx} → #${endIdx}`);

    let lastDetectedParsed = null;
    let lastSuggestion = '';
    let lastStateLore = '';
    let lastChatSnippet = '';
    let lastSummary = '';

    const closeFn = () => $('.popup').remove();
    $dialog.find('#lorediff_modal_close').on('click', closeFn);
    $dialog.find('#lorediff_modal_ok').on('click', closeFn);

    // Populate prompt profile dropdowns
    const $storySel = $dialog.find('#lorediff_modal_story_profile');
    renderModalPromptDropdown($storySel, getStoryProfiles(), extension_settings.loreDiff.storyPromptProfileId);
    $storySel.on('change', function () {
        extension_settings.loreDiff.storyPromptProfileId = String($(this).val());
        saveSettingsDebounced();
    });

    const $sceneSel = $dialog.find('#lorediff_modal_scene_profile');
    renderModalPromptDropdown($sceneSel, getSceneProfiles(), extension_settings.loreDiff.scenePromptProfileId);
    $sceneSel.on('change', function () {
        extension_settings.loreDiff.scenePromptProfileId = String($(this).val());
        saveSettingsDebounced();
    });

    // Prompt profile management buttons
    $dialog.find('#lorediff_modal_story_new').on('click', () => {
        createNewPromptProfile('story');
        renderModalPromptDropdown($storySel, getStoryProfiles(), extension_settings.loreDiff.storyPromptProfileId);
    });
    $dialog.find('#lorediff_modal_story_dup').on('click', () => {
        if (!ensureAtLeastOnePrompt(getStoryProfiles(), 'story')) return;
        duplicatePromptProfile('story');
        renderModalPromptDropdown($storySel, getStoryProfiles(), extension_settings.loreDiff.storyPromptProfileId);
    });
    $dialog.find('#lorediff_modal_story_del').on('click', () => {
        deletePromptProfile('story');
        renderModalPromptDropdown($storySel, getStoryProfiles(), extension_settings.loreDiff.storyPromptProfileId);
    });

    $dialog.find('#lorediff_modal_scene_new').on('click', () => {
        createNewPromptProfile('scene');
        renderModalPromptDropdown($sceneSel, getSceneProfiles(), extension_settings.loreDiff.scenePromptProfileId);
    });
    $dialog.find('#lorediff_modal_scene_dup').on('click', () => {
        if (!ensureAtLeastOnePrompt(getSceneProfiles(), 'scene')) return;
        duplicatePromptProfile('scene');
        renderModalPromptDropdown($sceneSel, getSceneProfiles(), extension_settings.loreDiff.scenePromptProfileId);
    });
    $dialog.find('#lorediff_modal_scene_del').on('click', () => {
        deletePromptProfile('scene');
        renderModalPromptDropdown($sceneSel, getSceneProfiles(), extension_settings.loreDiff.scenePromptProfileId);
    });

    function refreshInputs() {
        lastSummary = String($dialog.find('#lorediff_modal_summary').val() ?? '');
        lastChatSnippet = collectRecentChat(extension_settings.loreDiff.maxMessages, extension_settings.loreDiff.maxChars);
    }

    async function ensureBaseline() {
        refreshInputs();
        lastStateLore = await collectStateLoreText();
    }

    function installCopy(btnSel, outSel) {
        $dialog.find(btnSel).on('click', async () => {
            const text = String($dialog.find(outSel).text() ?? '').trim();
            if (!text || text === 'No result yet.') {
                toastr?.warning?.('LoreDiff: Nothing to copy.');
                return;
            }
            try {
                await copyText(text);
                toastr?.success?.('LoreDiff: Copied to clipboard.');
            } catch (err) {
                console.warn('LoreDiff: copyText failed', err);
                toastr?.error?.('LoreDiff: Copy failed (browser limitation).');
            }
        });
    }
    installCopy('#lorediff_modal_story_copy', '#lorediff_modal_story_out');
    installCopy('#lorediff_modal_scene_copy', '#lorediff_modal_scene_out');

    async function editPrompt(kind) {
        const profile = kind === 'story' ? getSelectedStoryProfile() : getSelectedSceneProfile();
        if (!profile) return;
        const title = kind === 'story' ? 'Edit STORY_STATE prompt' : 'Edit STATE prompt';
        const textarea = $('<textarea class="text_pole textarea_compact" rows="16"></textarea>');
        textarea.val(profile.template ?? '');
        const wrapper = $('<div></div>');
        wrapper.append(`<div style="opacity:0.85;margin-bottom:8px;">Profile: ${profile.name ?? profile.id}</div>`);
        wrapper.append(textarea);
        const result = await callGenericPopup(wrapper, POPUP_TYPE.CONFIRM, title, { okButton: 'Save', cancelButton: 'Cancel', wide: true, large: true, allowVerticalScrolling: true });
        if (result) {
            profile.template = String(textarea.val() ?? '');
            saveSettingsDebounced();
            toastr?.success?.('LoreDiff: Prompt saved.');
        }
    }

    $dialog.find('#lorediff_modal_story_edit').on('click', () => editPrompt('story'));
    $dialog.find('#lorediff_modal_scene_edit').on('click', () => editPrompt('scene'));

    async function openSettingsPopup() {
        ensureSettings();
        const external = isExternalMode();

        const wrapper = $('<div></div>');
        wrapper.append('<div style="opacity:0.85;margin-bottom:10px;">LoreDiff settings (stored in extension settings)</div>');

        const form = $(`
          <div class="flex-container flexGap10" style="flex-direction:column;">
            <label>Generation mode</label>
            <select id="lorediff_popup_request_mode" class="text_pole">
              <option value="st">SillyTavern (Connection Manager)</option>
              <option value="external">External API (OpenAI-compatible)</option>
            </select>

            <div id="lorediff_popup_external">
              <label>API Base URL</label>
              <input id="lorediff_popup_base_url" class="text_pole" type="text" placeholder="http://127.0.0.1:1234/v1" />
              <label>API Key</label>
              <input id="lorediff_popup_api_key" class="text_pole" type="password" placeholder="sk-..." />
              <label>Model</label>
              <input id="lorediff_popup_model" class="text_pole" type="text" placeholder="qwen3:4b" />
              <label>Temperature</label>
              <input id="lorediff_popup_temp" class="text_pole" type="number" min="0" max="2" step="0.05" />
              <div style="margin-top:8px;">
                <button class="menu_button" id="lorediff_popup_test">Test Connection</button>
              </div>
              <hr />
            </div>

            <label>Recent messages</label>
            <input id="lorediff_popup_messages" class="text_pole" type="number" min="5" max="200" step="1" />
            <label>Baseline lorebook</label>
            <select id="lorediff_popup_book" class="text_pole"></select>
            <label>Analysis budget (chars)</label>
            <input id="lorediff_popup_chars" class="text_pole" type="number" min="1000" max="100000" step="500" />
            <label>Max tokens</label>
            <input id="lorediff_popup_tokens" class="text_pole" type="number" min="64" max="4096" step="16" />
          </div>
        `);

        wrapper.append(form);

        form.find('#lorediff_popup_request_mode').val(extension_settings.loreDiff.requestMode);
        form.find('#lorediff_popup_base_url').val(extension_settings.loreDiff.externalApiBaseUrl);
        form.find('#lorediff_popup_api_key').val(extension_settings.loreDiff.externalApiKey);
        form.find('#lorediff_popup_model').val(extension_settings.loreDiff.externalModel);
        form.find('#lorediff_popup_temp').val(extension_settings.loreDiff.externalTemperature);
        form.find('#lorediff_popup_messages').val(extension_settings.loreDiff.maxMessages);
        form.find('#lorediff_popup_chars').val(extension_settings.loreDiff.maxChars);
        form.find('#lorediff_popup_tokens').val(extension_settings.loreDiff.maxTokens);

        // lorebook options
        const books = getAvailableLorebooks();
        const $book = form.find('#lorediff_popup_book');
        $book.empty();
        for (const b of books) $book.append($('<option></option>').attr('value', b).text(b));
        $book.val(extension_settings.loreDiff.baselineBook);

        const setExternalVis = () => {
            const mode = String(form.find('#lorediff_popup_request_mode').val());
            form.find('#lorediff_popup_external').toggleClass('hidden', mode !== 'external');
        };
        setExternalVis();
        form.find('#lorediff_popup_request_mode').on('change', setExternalVis);

        form.find('#lorediff_popup_test').on('click', async (e) => {
            e.preventDefault();
            // Copy current UI values into settings temporarily for the test.
            extension_settings.loreDiff.externalApiBaseUrl = String(form.find('#lorediff_popup_base_url').val());
            extension_settings.loreDiff.externalApiKey = String(form.find('#lorediff_popup_api_key').val());
            await testExternalConnection();
        });

        const ok = await callGenericPopup(wrapper, POPUP_TYPE.CONFIRM, 'LoreDiff Settings', {
            okButton: 'Save',
            cancelButton: 'Cancel',
            wide: true,
            large: true,
            allowVerticalScrolling: true,
        });

        if (!ok) return;

        extension_settings.loreDiff.requestMode = String(form.find('#lorediff_popup_request_mode').val());
        extension_settings.loreDiff.externalApiBaseUrl = String(form.find('#lorediff_popup_base_url').val());
        extension_settings.loreDiff.externalApiKey = String(form.find('#lorediff_popup_api_key').val());
        extension_settings.loreDiff.externalModel = String(form.find('#lorediff_popup_model').val());
        extension_settings.loreDiff.externalTemperature = Number(form.find('#lorediff_popup_temp').val());
        extension_settings.loreDiff.maxMessages = Number(form.find('#lorediff_popup_messages').val());
        extension_settings.loreDiff.baselineBook = String(form.find('#lorediff_popup_book').val());
        extension_settings.loreDiff.maxChars = Number(form.find('#lorediff_popup_chars').val());
        extension_settings.loreDiff.maxTokens = Number(form.find('#lorediff_popup_tokens').val());
        saveSettingsDebounced();
        toastr?.success?.('LoreDiff: Settings saved.');
    }

    $dialog.find('#lorediff_modal_settings').on('click', openSettingsPopup);

    $dialog.find('#lorediff_modal_story_run').on('click', async () => {
        $dialog.find('#lorediff_modal_story_run').prop('disabled', true);
        $dialog.find('#lorediff_modal_story_out').text('Generating...');
        $dialog.find('#lorediff_modal_story_copy').prop('disabled', true);
        try {
            await ensureBaseline();
            const out = await runTextExtraction({ kind: 'story', summary: lastSummary, stateLore: lastStateLore, chatSnippet: lastChatSnippet });
            $dialog.find('#lorediff_modal_story_out').text(out || 'No output.');
            $dialog.find('#lorediff_modal_story_copy').prop('disabled', !out);
        } catch (err) {
            console.error('LoreDiff story run failed', err);
            $dialog.find('#lorediff_modal_story_out').text(String(err?.message ?? err));
        } finally {
            $dialog.find('#lorediff_modal_story_run').prop('disabled', false);
        }
    });

    $dialog.find('#lorediff_modal_scene_run').on('click', async () => {
        $dialog.find('#lorediff_modal_scene_run').prop('disabled', true);
        $dialog.find('#lorediff_modal_scene_out').text('Generating...');
        $dialog.find('#lorediff_modal_scene_copy').prop('disabled', true);
        try {
            await ensureBaseline();
            const out = await runTextExtraction({ kind: 'scene', summary: lastSummary, stateLore: lastStateLore, chatSnippet: lastChatSnippet });
            $dialog.find('#lorediff_modal_scene_out').text(out || 'No output.');
            $dialog.find('#lorediff_modal_scene_copy').prop('disabled', !out);
        } catch (err) {
            console.error('LoreDiff scene run failed', err);
            $dialog.find('#lorediff_modal_scene_out').text(String(err?.message ?? err));
        } finally {
            $dialog.find('#lorediff_modal_scene_run').prop('disabled', false);
        }
    });

    callGenericPopup($dialog, POPUP_TYPE.TEXT, '', { wide: true, large: true, allowVerticalScrolling: true });
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

    // Sidebar intentionally minimal; workflow + settings live in the modal.
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

    // Add wand-menu trigger
    const wandButtonHtml = `
        <div id="lorediff_wand_button" class="list-group-item flex-container flexGap5">
            <div class="fa-solid fa-wand-magic-sparkles extensionsMenuExtensionButton" /></div>
            LoreDiff
        </div>`;
    // Use an existing container to keep v1 minimal.
    $('#data_bank_wand_container').append(wandButtonHtml);
    $('#lorediff_wand_button').on('click', openLoreDiffModal);
});
