import { extension_settings, getContext, loadExtensionSettings } from '../../../extensions.js';
import {
    saveSettingsDebounced,
    eventSource,
    event_types,
    updateMessageBlock,
    appendMediaToMessage,
} from '../../../../script.js';
import { regexFromString } from '../../../utils.js';

const extensionName = 'st-saac-image-gen';
const extensionFolderPath = `/scripts/extensions/third-party/${extensionName}`;

const INSERT_TYPE = {
    DISABLED: 'disabled',
    INLINE: 'inline',
    NEW_MESSAGE: 'new',
    REPLACE: 'replace',
};

const defaultSettings = {
    serverUrl: 'http://localhost:3000',
    defaultCharacter: '',
    insertType: INSERT_TYPE.INLINE,
    negativePrompt: '',
    promptInjection: {
        enabled: true,
        prompt: `<image_generation>\nAt the end of your response, output a <pic>visual description of the scene</pic> tag to generate an image.\n</image_generation>`,
        regex: '/<pic>(.*?)<\\/pic>/g',
        position: 'deep_system',
        depth: 0,
    },
};

function updateUI() {
    $('#saac_server_url').val(extension_settings[extensionName].serverUrl);
    $('#saac_default_character').val(extension_settings[extensionName].defaultCharacter);
    $('#saac_insert_type').val(extension_settings[extensionName].insertType);
    $('#saac_negative_prompt').val(extension_settings[extensionName].negativePrompt);
    $('#saac_prompt_injection_enabled').prop('checked', extension_settings[extensionName].promptInjection.enabled);
    $('#saac_prompt_template').val(extension_settings[extensionName].promptInjection.prompt);
    $('#saac_prompt_regex').val(extension_settings[extensionName].promptInjection.regex);
    $('#saac_injection_position').val(extension_settings[extensionName].promptInjection.position);
    $('#saac_injection_depth').val(extension_settings[extensionName].promptInjection.depth);
}

async function fetchCharacters() {
    const url = extension_settings[extensionName].serverUrl;
    try {
        const response = await fetch(`${url}/api/st/characters`);
        if (response.ok) {
            const data = await response.json();
            const charSelect = $('#saac_default_character');
            const currentValue = charSelect.val() || extension_settings[extensionName].defaultCharacter;

            charSelect.empty();
            charSelect.append(`<option value="">(None)</option>`);
            data.characters.forEach(char => {
                charSelect.append(`<option value="${char}">${char}</option>`);
            });

            charSelect.val(currentValue);
            // If the value is not in the list anymore, reset it
            if (charSelect.val() !== currentValue) {
                charSelect.val('');
                extension_settings[extensionName].defaultCharacter = '';
                saveSettingsDebounced();
            }

            // Initialize select2 if available in ST
            if (typeof charSelect.select2 === 'function') {
                charSelect.select2({
                    placeholder: 'Select a character',
                    allowClear: true,
                    width: '100%'
                });
                charSelect.on('change', () => {
                    extension_settings[extensionName].defaultCharacter = charSelect.val();
                    saveSettingsDebounced();
                });
            }
        }
    } catch (e) {
        console.warn('[SAAC] Failed to fetch characters:', e);
    }
}

async function loadSettings() {
    extension_settings[extensionName] = extension_settings[extensionName] || {};
    if (Object.keys(extension_settings[extensionName]).length === 0) {
        Object.assign(extension_settings[extensionName], JSON.parse(JSON.stringify(defaultSettings)));
    }
    updateUI();
}

async function testConnection() {
    const url = extension_settings[extensionName].serverUrl;
    try {
        const response = await fetch(`${url}/api/ws-config`);
        if (response.ok) {
            toastr.success('Connection successful');
        } else {
            toastr.error('Connection failed');
        }
    } catch (e) {
        toastr.error('Connection failed: ' + e.message);
    }
}

async function generateImage(params) {
    const url = extension_settings[extensionName].serverUrl;
    try {
        const response = await fetch(`${url}/api/st/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                character: params.character || extension_settings[extensionName].defaultCharacter,
                ai_prompt: params.ai_prompt || '',
                custom_prompt: params.custom_prompt || '',
                negative_prompt: extension_settings[extensionName].negativePrompt || undefined
            }),
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.error || 'Server error');
        }

        const data = await response.json();
        return data.image; // Base64
    } catch (e) {
        console.error('[SAAC] Generation error:', e);
        throw e;
    }
}

async function handleIncomingMessage(mesId) {
    if (extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED) return;

    const context = getContext();
    const message = context.chat[mesId];
    if (!message || message.is_user) return;

    const regexStr = extension_settings[extensionName].promptInjection.regex;
    const regex = regexFromString(regexStr);
    const matches = [...message.mes.matchAll(regex)];

    if (matches.length > 0) {
        toastr.info('Generating images via SAAC...');
        for (const match of matches) {
            try {
                // 现在 match[1] 是内容，match[0] 是完整标签
                const content = match[1];

                const base64Image = await generateImage({
                    character: extension_settings[extensionName].defaultCharacter,
                    ai_prompt: content, // 统一发送到 ai_prompt 由 SAAC 决定是否扩展
                    custom_prompt: ''
                });

                if (base64Image) {
                    const insertType = extension_settings[extensionName].insertType;
                    const fullBase64 = base64Image.startsWith('data:') ? base64Image : `data:image/png;base64,${base64Image}`;

                    if (insertType === INSERT_TYPE.INLINE || insertType === INSERT_TYPE.REPLACE || insertType === INSERT_TYPE.NEW_MESSAGE) {
                        if (insertType === INSERT_TYPE.INLINE || insertType === INSERT_TYPE.REPLACE) {
                            if (!message.extra) message.extra = {};
                            if (!message.extra.image_swipes) message.extra.image_swipes = [];

                            message.extra.image_swipes.push(fullBase64);
                            message.extra.image = fullBase64;
                            // 标题使用标签内的原始描述，更具可读性
                            message.extra.title = content.substring(0, 50);

                            if (insertType === INSERT_TYPE.REPLACE) {
                                const imgHtml = `<img src="${fullBase64}" style="max-width:100%;" />`;
                                message.mes = message.mes.replace(match[0], imgHtml);
                                updateMessageBlock(mesId, message);
                            } else {
                                const messageElement = $(`.mes[mesid="${mesId}"]`);
                                appendMediaToMessage(message, messageElement);
                            }
                        } else if (insertType === INSERT_TYPE.NEW_MESSAGE) {
                            // Logic for new message can be added if needed, but for now we follow reference
                            const imgHtml = `<img src="${fullBase64}" style="max-width:100%;" />`;
                            await context.addMessage({
                                role: 'assistant',
                                mes: imgHtml,
                                extra: { image: fullBase64, title: customPrompt || aiPrompt }
                            });
                        }
                    }
                    await context.saveChat();
                }
            } catch (e) {
                console.error('[SAAC] Image generation error:', e);
                toastr.error('SAAC Image Error: ' + e.message);
            }
        }
    }
}

// 按钮点击事件：打开设置面板
function onExtensionButtonClick() {
    const extensionsDrawer = $('#extensions-settings-button .drawer-toggle');
    if ($('#rm_extensions_block').hasClass('closedDrawer')) {
        extensionsDrawer.trigger('click');
    }
    setTimeout(() => {
        const container = $('#image_auto_generation_container');
        if (container.length) {
            $('#rm_extensions_block').animate({
                scrollTop: container.offset().top - $('#rm_extensions_block').offset().top + $('#rm_extensions_block').scrollTop(),
            }, 500);
            const drawerContent = container.find('.inline-drawer-content');
            if (drawerContent.is(':hidden')) {
                container.find('.inline-drawer-header').trigger('click');
            }
        }
    }, 500);
}

$(async function () {
    const settingsHtml = await $.get(`${extensionFolderPath}/settings.html`);
    $('#extensionsMenu').append(`<div id="saac_gen_menu" class="list-group-item flex-container flexGap5">
        <div class="fa-solid fa-paintbrush"></div>
        <span data-i18n="SAAC Image Generation">SAAC Image Generation</span>
    </div>`);

    $('#saac_gen_menu').on('click', onExtensionButtonClick);

    if (!$('#image_auto_generation_container').length) {
        $('#extensions_settings2').append('<div id="image_auto_generation_container" class="extension_container"></div>');
    }
    $('#image_auto_generation_container').append(settingsHtml);

    // Event Listeners for UI
    $('#saac_server_url').on('input', () => { extension_settings[extensionName].serverUrl = $('#saac_server_url').val(); saveSettingsDebounced(); });
    $('#saac_default_character').on('change', () => { extension_settings[extensionName].defaultCharacter = $('#saac_default_character').val(); saveSettingsDebounced(); });
    $('#saac_insert_type').on('change', () => { extension_settings[extensionName].insertType = $('#saac_insert_type').val(); saveSettingsDebounced(); });
    $('#saac_negative_prompt').on('input', () => { extension_settings[extensionName].negativePrompt = $('#saac_negative_prompt').val(); saveSettingsDebounced(); });
    $('#saac_prompt_injection_enabled').on('change', () => { extension_settings[extensionName].promptInjection.enabled = $('#saac_prompt_injection_enabled').prop('checked'); saveSettingsDebounced(); });
    $('#saac_prompt_template').on('input', () => { extension_settings[extensionName].promptInjection.prompt = $('#saac_prompt_template').val(); saveSettingsDebounced(); });
    $('#saac_prompt_regex').on('input', () => { extension_settings[extensionName].promptInjection.regex = $('#saac_prompt_regex').val(); saveSettingsDebounced(); });
    $('#saac_injection_position').on('change', () => { extension_settings[extensionName].promptInjection.position = $('#saac_injection_position').val(); saveSettingsDebounced(); });
    $('#saac_injection_depth').on('input', () => { extension_settings[extensionName].promptInjection.depth = parseInt($('#saac_injection_depth').val()); saveSettingsDebounced(); });
    $('#saac_test_connection').on('click', testConnection);
    $('#saac_refresh_characters').on('click', fetchCharacters);

    await loadSettings();
    await fetchCharacters();

    eventSource.on(event_types.CHAT_COMPLETION_PROMPT_READY, (eventData) => {
        if (!extension_settings[extensionName].promptInjection.enabled || extension_settings[extensionName].insertType === INSERT_TYPE.DISABLED) return;

        const { prompt, position, depth } = extension_settings[extensionName].promptInjection;
        const role = position === 'deep_assistant' ? 'assistant' : (position === 'deep_user' ? 'user' : 'system');

        if (depth === 0) {
            eventData.chat.push({ role, content: prompt });
        } else {
            eventData.chat.splice(-depth, 0, { role, content: prompt });
        }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, async (data) => {
        const context = getContext();
        await handleIncomingMessage(context.chat.length - 1);
    });
});
