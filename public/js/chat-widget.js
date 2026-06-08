// ИИ-ассистент Ворк.Тап - Отладочная версия
(function() {
    let isSending = false;
    let isWidgetOpen = false;

    function addMessage(text, isUser) {
        const container = document.getElementById('worktapChatMessages');
        if (!container) return;

        const messageDiv = document.createElement('div');
        messageDiv.className = `worktap-message ${isUser ? 'worktap-user' : 'worktap-bot'}`;
        messageDiv.innerHTML = `
            <div class="worktap-message-avatar">${isUser ? '👤' : '🤖'}</div>
            <div class="worktap-message-bubble">
                <div class="worktap-message-text">${text.replace(/\n/g, '<br>')}</div>
                <div class="worktap-message-time">${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</div>
            </div>
        `;
        container.appendChild(messageDiv);
        container.scrollTop = container.scrollHeight;
    }

    function addQuickCommands() {
        const oldCommands = document.querySelector('.worktap-quick-commands');
        if (oldCommands) oldCommands.remove();

        const commands = ['/top', '/freelancers', '/categories', '/help'];
        const container = document.getElementById('worktapChatMessages');
        if (!container) return;

        const commandsDiv = document.createElement('div');
        commandsDiv.className = 'worktap-quick-commands';
        commandsDiv.innerHTML = `
            <div class="worktap-quick-commands-title">💡 Быстрые команды:</div>
            <div class="worktap-quick-commands-buttons">
                ${commands.map(cmd => `<button class="worktap-quick-cmd" data-cmd="${cmd}">${cmd}</button>`).join('')}
            </div>
        `;
        container.appendChild(commandsDiv);

        document.querySelectorAll('.worktap-quick-cmd').forEach(btn => {
            btn.onclick = function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (isSending) return;
                const cmd = this.getAttribute('data-cmd');
                const input = document.getElementById('worktapChatInput');
                if (input) {
                    input.value = cmd;
                    sendMessage();
                }
                return false;
            };
        });
    }

    async function sendMessage() {
        if (isSending) return;

        const input = document.getElementById('worktapChatInput');
        const message = input.value.trim();
        if (!message) return;

        isSending = true;

        const sendBtn = document.getElementById('worktapChatSendBtn');
        if (sendBtn) {
            sendBtn.disabled = true;
            sendBtn.style.opacity = '0.5';
        }

        addMessage(message, true);
        input.value = '';

        const container = document.getElementById('worktapChatMessages');
        const typingDiv = document.createElement('div');
        typingDiv.className = 'worktap-message worktap-bot';
        typingDiv.id = 'worktapTypingIndicator';
        typingDiv.innerHTML = `
            <div class="worktap-message-avatar">🤖</div>
            <div class="worktap-message-bubble">
                <div class="worktap-message-text">
                    <span class="worktap-typing">печатает</span>
                </div>
            </div>
        `;
        container.appendChild(typingDiv);
        container.scrollTop = container.scrollHeight;

        try {
            const response = await fetch('/api/ai-assistant', {
                method: 'POST',
                headers: {'Content-Type': 'application/json'},
                body: JSON.stringify({message: message})
            });

            const data = await response.json();
            const reply = data.reply || '😔 Извините, произошла ошибка. Попробуйте позже.';

            const typingIndicator = document.getElementById('worktapTypingIndicator');
            if (typingIndicator) typingIndicator.remove();
            addMessage(reply, false);
            addQuickCommands();
        } catch (error) {
            console.error('Ошибка:', error);
            const typingIndicator = document.getElementById('worktapTypingIndicator');
            if (typingIndicator) typingIndicator.remove();
            addMessage('😔 Ошибка соединения. Попробуйте позже или напишите нам в поддержку.', false);
        } finally {
            isSending = false;
            if (sendBtn) {
                sendBtn.disabled = false;
                sendBtn.style.opacity = '1';
            }
        }
    }

    function createWidget() {
        if (document.getElementById('worktapChatRoot')) {
            console.log('Виджет уже существует');
            return;
        }

        const styles = document.createElement('style');
        styles.textContent = `
            #worktapChatRoot {
                position: fixed !important;
                bottom: 30px !important;
                right: 30px !important;
                z-index: 999999 !important;
                font-family: 'Inter', system-ui, sans-serif !important;
            }
            .worktap-chat-toggle {
                width: 60px !important;
                height: 60px !important;
                background: #1DBF73 !important;
                border: none !important;
                border-radius: 50% !important;
                cursor: pointer !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                box-shadow: 0 4px 15px rgba(29, 191, 115, 0.35) !important;
                transition: all 0.3s ease !important;
            }
            .worktap-chat-toggle:hover {
                transform: scale(1.08) !important;
                background: #179e5f !important;
                box-shadow: 0 6px 20px rgba(29, 191, 115, 0.45) !important;
            }
            .worktap-chat-toggle i {
                font-size: 28px !important;
                color: white !important;
            }
            .worktap-chat-window {
                position: fixed !important;
                bottom: 105px !important;
                right: 30px !important;
                width: 380px !important;
                height: 560px !important;
                background: white !important;
                border-radius: 28px !important;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.15) !important;
                flex-direction: column !important;
                overflow: hidden !important;
                border: 1px solid rgba(29, 191, 115, 0.2) !important;
                z-index: 999998 !important;
            }
            .worktap-chat-header {
                background: #1DBF73 !important;
                padding: 18px 20px !important;
                display: flex !important;
                justify-content: space-between !important;
                align-items: center !important;
                color: white !important;
            }
            .worktap-chat-header-info {
                display: flex !important;
                align-items: center !important;
                gap: 10px !important;
                font-weight: 700 !important;
                font-size: 16px !important;
            }
            .worktap-chat-header-info i {
                font-size: 22px !important;
            }
            .worktap-chat-close {
                background: none !important;
                border: none !important;
                color: white !important;
                font-size: 20px !important;
                cursor: pointer !important;
                opacity: 0.8 !important;
            }
            .worktap-chat-close:hover {
                opacity: 1 !important;
            }
            .worktap-chat-messages {
                flex: 1 !important;
                overflow-y: auto !important;
                padding: 16px !important;
                background: #F6FAFD !important;
                display: flex !important;
                flex-direction: column !important;
                gap: 12px !important;
            }
            .worktap-message {
                display: flex !important;
                gap: 10px !important;
                align-items: flex-start !important;
                animation: worktapFadeIn 0.3s ease !important;
            }
            @keyframes worktapFadeIn {
                from {
                    opacity: 0;
                    transform: translateY(10px);
                }
                to {
                    opacity: 1;
                    transform: translateY(0);
                }
            }
            .worktap-user {
                flex-direction: row-reverse !important;
            }
            .worktap-message-avatar {
                width: 34px !important;
                height: 34px !important;
                background: #F2F0FE !important;
                border-radius: 50% !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                font-size: 16px !important;
                flex-shrink: 0 !important;
            }
            .worktap-user .worktap-message-avatar {
                background: #1DBF73 !important;
                color: white !important;
            }
            .worktap-message-bubble {
                max-width: 75% !important;
            }
            .worktap-message-text {
                background: white !important;
                padding: 10px 16px !important;
                border-radius: 20px !important;
                font-size: 13px !important;
                line-height: 1.5 !important;
                color: #222222 !important;
                box-shadow: 0 1px 2px rgba(0,0,0,0.05) !important;
            }
            .worktap-user .worktap-message-text {
                background: #1DBF73 !important;
                color: white !important;
            }
            .worktap-message-time {
                font-size: 10px !important;
                color: #8a9bb0 !important;
                margin-top: 4px !important;
                margin-left: 4px !important;
            }
            .worktap-typing {
                display: inline-block !important;
            }
            .worktap-typing::after {
                content: '...' !important;
                animation: worktapDots 1.5s steps(4, end) infinite !important;
            }
            @keyframes worktapDots {
                0%, 20% { content: ''; }
                40% { content: '.'; }
                60% { content: '..'; }
                80%, 100% { content: '...'; }
            }
            .worktap-chat-input-area {
                padding: 12px 16px !important;
                background: white !important;
                border-top: 1px solid #eef2f6 !important;
                display: flex !important;
                gap: 10px !important;
            }
            .worktap-chat-input {
                flex: 1 !important;
                padding: 12px 16px !important;
                border: 1.5px solid #e2e8f0 !important;
                border-radius: 40px !important;
                font-size: 13px !important;
                font-family: 'Inter', sans-serif !important;
                outline: none !important;
            }
            .worktap-chat-input:focus {
                border-color: #1DBF73 !important;
            }
            .worktap-chat-send {
                width: 44px !important;
                height: 44px !important;
                background: #1DBF73 !important;
                border: none !important;
                border-radius: 50% !important;
                display: flex !important;
                align-items: center !important;
                justify-content: center !important;
                cursor: pointer !important;
                transition: all 0.2s !important;
            }
            .worktap-chat-send:hover {
                transform: scale(1.05) !important;
                background: #179e5f !important;
            }
            .worktap-chat-send i {
                color: white !important;
                font-size: 14px !important;
            }
            .worktap-quick-commands {
                padding: 10px 0 !important;
                border-top: 1px solid #eef2f6 !important;
                margin-top: 8px !important;
            }
            .worktap-quick-commands-title {
                font-size: 11px !important;
                color: #8a9bb0 !important;
                margin-bottom: 8px !important;
            }
            .worktap-quick-commands-buttons {
                display: flex !important;
                flex-wrap: wrap !important;
                gap: 8px !important;
            }
            .worktap-quick-cmd {
                background: #F2F0FE !important;
                border: 1px solid #1DBF73 !important;
                color: #1DBF73 !important;
                padding: 5px 14px !important;
                border-radius: 40px !important;
                font-size: 11px !important;
                font-weight: 600 !important;
                cursor: pointer !important;
                transition: all 0.2s !important;
                font-family: 'Inter', monospace !important;
            }
            .worktap-quick-cmd:hover {
                background: #1DBF73 !important;
                color: white !important;
            }
            @media (max-width: 480px) {
                .worktap-chat-window {
                    width: calc(100vw - 40px) !important;
                    height: 500px !important;
                    right: 20px !important;
                    bottom: 90px !important;
                }
                #worktapChatRoot {
                    bottom: 20px !important;
                    right: 20px !important;
                }
            }
        `;
        document.head.appendChild(styles);

        if (!document.querySelector('link[href*="font-awesome"]')) {
            const link = document.createElement('link');
            link.rel = 'stylesheet';
            link.href = 'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css';
            document.head.appendChild(link);
        }

        const widgetHtml = `
            <div id="worktapChatRoot">
                <button class="worktap-chat-toggle" id="worktapChatToggleBtn">
                    <i class="fas fa-robot"></i>
                </button>
                <div class="worktap-chat-window" id="worktapChatWindow">
                    <div class="worktap-chat-header">
                        <div class="worktap-chat-header-info">
                            <i class="fas fa-briefcase"></i>
                            <span>Ворк.Тап AI</span>
                        </div>
                        <button class="worktap-chat-close" id="worktapChatCloseBtn">✕</button>
                    </div>
                    <div class="worktap-chat-messages" id="worktapChatMessages">
                        <div class="worktap-message worktap-bot">
                            <div class="worktap-message-avatar">🤖</div>
                            <div class="worktap-message-bubble">
                                <div class="worktap-message-text">
                                    👋 Привет! Я ИИ-ассистент Ворк.Тап.<br><br>
                                    💼 Что я могу:<br>
                                    • Найти фрилансера или услугу<br>
                                    • Помочь с созданием заказа<br>
                                    • Рассказать о ценах и оплате<br>
                                    • Подсказать топовые услуги<br><br>
                                    💡 Введите <b>/help</b> для списка команд<br><br>
                                    Чем могу помочь?
                                </div>
                                <div class="worktap-message-time">${new Date().toLocaleTimeString([], {hour: '2-digit', minute: '2-digit'})}</div>
                            </div>
                        </div>
                    </div>
                    <div class="worktap-chat-input-area">
                        <input type="text" class="worktap-chat-input" id="worktapChatInput" placeholder="Напишите сообщение..." autocomplete="off">
                        <button class="worktap-chat-send" id="worktapChatSendBtn">
                            <i class="fas fa-paper-plane"></i>
                        </button>
                    </div>
                </div>
            </div>
        `;
        document.body.insertAdjacentHTML('beforeend', widgetHtml);

        console.log('Виджет создан');
        console.log('Элемент chatWindow:', document.getElementById('worktapChatWindow'));
    }

    function init() {
        createWidget();

        const toggleBtn = document.getElementById('worktapChatToggleBtn');
        const closeBtn = document.getElementById('worktapChatCloseBtn');
        const chatWindow = document.getElementById('worktapChatWindow');
        const sendBtn = document.getElementById('worktapChatSendBtn');
        const input = document.getElementById('worktapChatInput');

        console.log('Найденные элементы:', {
            toggleBtn: !!toggleBtn,
            chatWindow: !!chatWindow,
            closeBtn: !!closeBtn,
            sendBtn: !!sendBtn,
            input: !!input
        });

        if (toggleBtn) {
            toggleBtn.onclick = function(e) {
                e.preventDefault();
                console.log('Кнопка нажата');
                console.log('chatWindow до открытия:', chatWindow.style.display);

                if (chatWindow) {
                    chatWindow.style.display = 'flex';
                    this.style.display = 'none';
                    console.log('chatWindow после открытия:', chatWindow.style.display);
                    console.log('chatWindow computed display:', window.getComputedStyle(chatWindow).display);
                    addQuickCommands();
                } else {
                    console.error('chatWindow не найден!');
                }
                return false;
            };
        }

        if (closeBtn) {
            closeBtn.onclick = function(e) {
                e.preventDefault();
                if (chatWindow) {
                    chatWindow.style.display = 'none';
                    if (toggleBtn) toggleBtn.style.display = 'flex';
                }
                return false;
            };
        }

        if (sendBtn) {
            sendBtn.onclick = function(e) {
                e.preventDefault();
                sendMessage();
                return false;
            };
        }

        if (input) {
            input.onkeypress = function(e) {
                if (e.key === 'Enter') {
                    e.preventDefault();
                    sendMessage();
                    return false;
                }
            };
        }

        // Убираем display: none из CSS и устанавливаем начальное состояние через JS
        if (chatWindow) {
            chatWindow.style.display = 'none';
            console.log('Начальное состояние чата: скрыт');
        }
        if (toggleBtn) {
            toggleBtn.style.display = 'flex';
        }

        console.log('Чат инициализирован');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }
})();
