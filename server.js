const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const https = require('https');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3000;
const dataDir = process.env.WORKTAP_DATA_DIR
    ? path.resolve(process.env.WORKTAP_DATA_DIR)
    : __dirname;
fs.mkdirSync(dataDir, {recursive: true});
const dbPath = process.env.WORKTAP_DB_PATH
    ? path.resolve(process.env.WORKTAP_DB_PATH)
    : path.join(dataDir, 'worktap.db');
const chatUploadDir = process.env.WORKTAP_UPLOAD_DIR
    ? path.resolve(process.env.WORKTAP_UPLOAD_DIR, 'chat')
    : path.join(__dirname, 'public', 'uploads', 'chat');
fs.mkdirSync(chatUploadDir, {recursive: true});

function parseWorkImages(images) {
    if (!images) return [];
    try {
        const parsed = typeof images === 'string' ? JSON.parse(images) : images;
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
    } catch (err) {
        return [];
    }
}

function normalizeWorkCard(work) {
    const images = parseWorkImages(work.images);
    return {
        ...work,
        price: work.price ? Number(work.price) : null,
        thumbnail: images[0] || work.seller_avatar || '/images/avatar-placeholder.jpg'
    };
}

function makeSlug(value) {
    const base = String(value || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9а-яё]+/gi, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80);
    return base || `work-${Date.now()}`;
}

function roleAllows(user, roles) {
    if (!user) return false;
    const allowed = Array.isArray(roles) ? roles : [roles];
    if (user.role === 'admin') return true;
    return user.role === 'both' || allowed.includes(user.role);
}

function requireAdminPage(req, res) {
    if (!req.session.user) {
        res.redirect('/login');
        return false;
    }
    if (req.session.user.role !== 'admin') {
        res.status(403).send('Эта страница доступна только администратору');
        return false;
    }
    return true;
}

function requireAdminApi(req, res) {
    if (!req.session.user) {
        res.status(401).json({error: 'Требуется авторизация'});
        return false;
    }
    if (req.session.user.role !== 'admin') {
        res.status(403).json({error: 'Действие доступно только администратору'});
        return false;
    }
    return true;
}

function getUserConversations(userId) {
    return new Promise((resolve) => {
        db.all(`
            WITH dialog_messages AS (
                SELECT
                    CASE WHEN m.from_user_id = ? THEN m.to_user_id ELSE m.from_user_id END as user_id,
                    m.message,
                    m.created_at,
                    m.id as message_id
                FROM messages m
                WHERE m.from_user_id = ? OR m.to_user_id = ?
            ),
            latest AS (
                SELECT dm.*
                FROM dialog_messages dm
                JOIN (
                    SELECT user_id, MAX(created_at || printf('%010d', message_id)) as sort_key
                    FROM dialog_messages
                    GROUP BY user_id
                ) grouped ON grouped.user_id = dm.user_id
                    AND grouped.sort_key = dm.created_at || printf('%010d', dm.message_id)
            )
            SELECT latest.user_id,
                   u.full_name,
                   CASE
                       WHEN latest.message IS NULL OR latest.message = '' THEN '[Фото]'
                       ELSE latest.message
                   END as last_message,
                   latest.created_at
            FROM latest
                     JOIN users u ON u.id = latest.user_id
            ORDER BY latest.created_at DESC
            LIMIT 20
        `, [userId, userId, userId], (err, rows) => {
            resolve(rows || []);
        });
    });
}

function getFavoriteWorkIds(userId) {
    if (!userId) return Promise.resolve([]);
    return new Promise((resolve) => {
        db.all('SELECT work_id FROM favorites WHERE user_id = ? AND work_id IS NOT NULL', [userId], (err, rows) => {
            resolve((rows || []).map(row => Number(row.work_id)));
        });
    });
}

function requireRolePage(req, res, roles) {
    if (!req.session.user) {
        res.redirect('/login');
        return false;
    }
    if (!roleAllows(req.session.user, roles)) {
        res.status(403).send('Эта страница недоступна для вашей роли');
        return false;
    }
    return true;
}

function requireRoleApi(req, res, roles) {
    if (!req.session.user) {
        res.status(401).json({error: 'Требуется авторизация'});
        return false;
    }
    if (!roleAllows(req.session.user, roles)) {
        res.status(403).json({error: 'Действие недоступно для вашей роли'});
        return false;
    }
    return true;
}

// Подключение к БД
const db = new sqlite3.Database(dbPath, sqlite3.OPEN_READWRITE | sqlite3.OPEN_CREATE, (err) => {
    if (err) {
        console.error('Ошибка подключения к БД:', err.message);
        console.error(`SQLite path: ${dbPath}`);
    } else {
        console.log(`✅ Подключено к SQLite базе данных: ${dbPath}`);
    }
});
db.configure('busyTimeout', 5000);

// Настройка шаблонов
db.serialize(() => {
    db.run(`
        CREATE TABLE IF NOT EXISTS message_attachments (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            message_id INTEGER NOT NULL,
            file_path TEXT NOT NULL,
            file_name TEXT,
            mime_type TEXT,
            size INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (message_id) REFERENCES messages(id) ON DELETE CASCADE
        )
    `);
    db.run(`
        UPDATE users
        SET phone = NULL
        WHERE phone IS NOT NULL
          AND phone != ''
          AND phone IN (
              SELECT phone
              FROM users
              WHERE phone IS NOT NULL AND phone != ''
              GROUP BY phone
              HAVING COUNT(id) != 1
          )
          AND id NOT IN (
              SELECT MIN(id)
              FROM users
              WHERE phone IS NOT NULL AND phone != ''
              GROUP BY phone
          )
    `);
    db.run(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_users_phone_unique
        ON users(phone)
        WHERE phone IS NOT NULL AND phone != ''
    `);
    db.run(`CREATE INDEX IF NOT EXISTS idx_messages_users_created ON messages(from_user_id, to_user_id, created_at)`);
    db.run(`CREATE INDEX IF NOT EXISTS idx_message_attachments_message ON message_attachments(message_id)`);
    db.get('SELECT id FROM users WHERE role = ? LIMIT 1', ['admin'], (err, row) => {
        if (!err && !row) {
            const hash = bcrypt.hashSync('admin123', 10);
            db.run(`
                INSERT INTO users (email, password_hash, full_name, phone, role, on_site_since, is_active)
                VALUES ('admin@worktap.local', ?, 'Администратор Ворк.Тап', NULL, 'admin', date('now'), 1)
            `, [hash], function (insertErr) {
                if (!insertErr) {
                    db.run('INSERT INTO wallets (user_id, balance, frozen_balance) VALUES (?, 0, 0)', [this.lastID]);
                }
            });
        }
    });
});

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Middleware
app.use(express.json({limit: '30mb'}));
app.use(express.urlencoded({extended: true, limit: '30mb'}));
app.use(express.static(path.join(__dirname, 'public')));
// ИЛИ явно для images
app.use('/images', express.static(path.join(__dirname, 'public/images')));

// Сессии
app.use(session({
    secret: 'worktap_secret_key_2025',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 1000 * 60 * 60 * 24
    }
}));

// Конфигурация GigaChat
const GIGACHAT_AUTH_URL = "https://ngw.devices.sberbank.ru:9443/api/v2/oauth";
const GIGACHAT_API_URL = "https://gigachat.devices.sberbank.ru/api/v1/chat/completions";
const GIGACHAT_AUTHORIZATION_KEY = "MDE5ZGFmODMtMjA5ZS03OTkzLTg1NjgtYTU1MjhiOGJlYmY4OjdmZTY2NDg1LTUzYzgtNGY4NS05ZWFhLTA3ZTUxY2JlYzFmMg==";

let gigachatTokenCache = {token: null, expiresAt: 0};
let gigaChatAvailable = true;

// Функция для HTTP запросов без fetch
function httpsRequest(options, body = null) {
    return new Promise((resolve, reject) => {
        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const parsed = JSON.parse(data);
                    resolve({status: res.statusCode, data: parsed});
                } catch (e) {
                    resolve({status: res.statusCode, data: data});
                }
            });
        });

        req.on('error', (error) => {
            reject(error);
        });

        if (body) {
            req.write(body);
        }

        req.end();
    });
}

// Функция получения токена
async function getGigaChatToken() {
    // Проверяем кэш
    if (gigachatTokenCache.token && gigachatTokenCache.expiresAt > Date.now() / 1000) {
        return gigachatTokenCache.token;
    }

    try {
        const rquid = crypto.randomUUID();
        console.log('🔄 Получение токена GigaChat...');

        const options = {
            hostname: 'ngw.devices.sberbank.ru',
            port: 9443,
            path: '/api/v2/oauth',
            method: 'POST',
            headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Accept': 'application/json',
                'RqUID': rquid,
                'Authorization': `Basic ${GIGACHAT_AUTHORIZATION_KEY}`
            },
            rejectUnauthorized: false
        };

        const response = await httpsRequest(options, 'scope=GIGACHAT_API_PERS');

        if (response.status === 200 && response.data.access_token) {
            gigachatTokenCache.token = response.data.access_token;
            gigachatTokenCache.expiresAt = (Date.now() / 1000) + (response.data.expires_in || 1800) - 60;
            console.log('✅ Токен GigaChat получен для Ворк.Тап');
            return response.data.access_token;
        }

        console.error('❌ Ошибка получения токена:', response.data);
        return null;
    } catch (error) {
        console.error('❌ Ошибка получения токена:', error.message);
        return null;
    }
}

// Функция запроса к GigaChat
async function askGigaChat(userMessage) {
    const token = await getGigaChatToken();
    if (!token) return null;

    const systemPrompt = `Ты дружелюбный ИИ-ассистент Ворк.Тап — фриланс-биржи услуг.

КОМАНДЫ (пользователь может вводить их для быстрых действий):
🔹 /top — показать топовые услуги
🔹 /freelancers — топ фрилансеры
🔹 /categories — все категории
🔹 /help — помощь по командам

ОСНОВНАЯ ИНФОРМАЦИЯ О ВОРК.ТАП:
- Ворк.Тап — маркетплейс фриланс-услуг
- Покупатели заказывают услуги (ворки) у продавцов
- Фрилансеры могут создавать ворки и откликаться на проекты
- Есть безопасная сделка: деньги замораживаются до завершения работы
- Кошелёк: пополнение от 100 ₽, вывод от 500 ₽
- Комиссия платформы: 10% от суммы заказа

ЦЕНЫ НА УСЛУГИ (примерные):
- Дизайн логотипа: 1000-5000 ₽
- Landing Page: 5000-20000 ₽
- Текст для сайта: 500-3000 ₽
- SEO-продвижение: 10000-50000 ₽
- Рекламный баннер: 500-2000 ₽

ПРАВИЛА ОТВЕТОВ:
1. Отвечай коротко и по делу (3-5 предложений максимум)
2. Если пользователь спрашивает цену — назови примерную цену
3. Всегда будь вежливым и предлагай дальнейшую помощь
4. Используй эмодзи: 💼🎨💻💰🛡️👨‍💻`;

    try {
        const requestId = crypto.randomUUID();

        const requestBody = JSON.stringify({
            model: 'GigaChat',
            messages: [
                {role: 'system', content: systemPrompt},
                {role: 'user', content: userMessage}
            ],
            temperature: 0.7,
            max_tokens: 600
        });

        const options = {
            hostname: 'gigachat.devices.sberbank.ru',
            port: 443,
            path: '/api/v1/chat/completions',
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json',
                'Accept': 'application/json',
                'X-Request-Id': requestId,
                'Content-Length': Buffer.byteLength(requestBody)
            },
            rejectUnauthorized: false
        };

        console.log('📤 Отправка запроса к GigaChat...');
        const response = await httpsRequest(options, requestBody);

        if (response.status === 200 && response.data.choices && response.data.choices[0]) {
            let reply = response.data.choices[0].message.content;
            console.log('✅ Ответ от GigaChat получен');
            return reply;
        }

        console.error('❌ Ошибка GigaChat API:', response.status, response.data);
        return null;
    } catch (error) {
        console.error('❌ Ошибка GigaChat:', error.message);
        return null;
    }
}

// Обновите эндпоинт /api/ai-assistant
// Эндпоинт для чата с поддержкой реальных данных из БД
app.post('/api/ai-assistant', async (req, res) => {
    console.log('🤖 Запрос к ИИ-ассистенту:', req.body?.message);

    const {message} = req.body;
    const userId = req.session.user?.id || null;

    if (!message) {
        return res.json({reply: '👋 Напишите, чем я могу вам помочь!'});
    }

    try {
        // Пытаемся получить ответ от GigaChat
        let aiReply = null;
        if (gigaChatAvailable) {
            aiReply = await askGigaChat(message, userId);
        }

        if (aiReply) {
            return res.json({reply: aiReply});
        }

        // Fallback ответы с реальными данными из БД
        const lower = message.toLowerCase().trim();

        // Обработка команды /top - топ услуги из БД
        if (lower === '/top') {
            const topWorks = await new Promise((resolve) => {
                db.all(`
                    SELECT w.title, w.price_from, c.name as category_name, u.full_name as seller_name
                    FROM works w
                             JOIN categories c ON w.category_id = c.id
                             JOIN users u ON w.seller_id = u.id
                    WHERE w.is_active = 1
                    ORDER BY w.orders_count DESC, w.rating DESC LIMIT 5
                `, (err, rows) => {
                    resolve(rows || []);
                });
            });

            if (topWorks.length > 0) {
                let reply = '🏆 **Топовые услуги на Ворк.Тап:**\n\n';
                topWorks.forEach((work, index) => {
                    reply += `${index + 1}. **${work.title}** — от ${work.price_from} ₽\n`;
                    reply += `   Категория: ${work.category_name} | Продавец: ${work.seller_name}\n\n`;
                });
                reply += '➡️ Перейдите в каталог услуг, чтобы заказать!';
                return res.json({reply: reply});
            }
            return res.json({reply: '🏆 Пока нет топовых услуг, но вы можете создать первый заказ!'});
        }

        // Обработка команды /freelancers - топ фрилансеры из БД
        // Обработка команды /freelancers - с реальными данными из БД
        if (lower === '/freelancers') {
            console.log('📊 Запрос списка фрилансеров из БД...');

            const topFreelancers = await new Promise((resolve) => {
                db.all(`
                    SELECT id, full_name, specialization, rating, completed_projects, avatar_url, bio
                    FROM users
                    WHERE role IN ('freelancer', 'both')
                    ORDER BY rating DESC, completed_projects DESC LIMIT 5
                `, (err, rows) => {
                    if (err) {
                        console.error('Ошибка БД:', err);
                        resolve([]);
                    } else {
                        console.log(`✅ Найдено ${rows.length} фрилансеров`);
                        resolve(rows || []);
                    }
                });
            });

            if (topFreelancers.length > 0) {
                let reply = '👨‍💻 **Топ-фрилансеры платформы:**\n\n';

                topFreelancers.forEach((freelancer, index) => {
                    const stars = '⭐'.repeat(Math.min(Math.floor(freelancer.rating || 0), 5));
                    const emptyStars = '☆'.repeat(Math.max(5 - Math.floor(freelancer.rating || 0), 0));

                    reply += `${index + 1}. **${freelancer.full_name}**\n`;
                    reply += `   📌 ${freelancer.specialization || 'Профессиональный фрилансер'}\n`;
                    reply += `   ⭐ Рейтинг: ${freelancer.rating || 0} ${stars}${emptyStars}\n`;
                    reply += `   ✅ Завершено проектов: ${freelancer.completed_projects || 0}\n`;
                    if (freelancer.bio) {
                        const shortBio = freelancer.bio.length > 100 ? freelancer.bio.substring(0, 100) + '...' : freelancer.bio;
                        reply += `   📝 ${shortBio}\n`;
                    }
                    reply += `   🔗 Подробнее: /profile/${freelancer.id}\n\n`;
                });

                reply += '💡 **Хотите узнать больше?**\n';
                reply += '• Напишите имя фрилансера, чтобы увидеть полный профиль\n';
                reply += '• Или спросите: "найди фрилансера по дизайну"\n';
                reply += '• Можете также посмотреть их портфолио на странице профиля';

                return res.json({reply: reply});
            } else {
                // Если в БД нет фрилансеров, показываем предложение стать фрилансером
                return res.json({
                    reply: '👨‍💻 **На платформе пока нет активных фрилансеров**\n\n' +
                        'Но вы можете стать первым! 🚀\n\n' +
                        '**Как стать фрилансером:**\n' +
                        '1. Зарегистрируйтесь на платформе\n' +
                        '2. В профиле выберите роль "Фрилансер"\n' +
                        '3. Создайте свои услуги (ворки)\n' +
                        '4. Начните зарабатывать!\n\n' +
                        '💡 Хотите узнать подробнее о регистрации?'
                });
            }
        }

        // Обработка команды /categories - категории из БД
        if (lower === '/categories') {
            const categories = await new Promise((resolve) => {
                db.all(`
                    SELECT id, name, icon, description
                    FROM categories
                    WHERE parent_id IS NULL
                    ORDER BY sort_order LIMIT 10
                `, (err, rows) => {
                    resolve(rows || []);
                });
            });

            if (categories.length > 0) {
                let reply = '📁 **Категории услуг на Ворк.Тап:**\n\n';
                categories.forEach(cat => {
                    const icon = cat.icon || '📌';
                    reply += `${icon} **${cat.name}**\n`;
                    if (cat.description) reply += `   ${cat.description}\n`;
                    reply += '\n';
                });
                reply += 'Какая категория вас интересует? Я могу подобрать услуги!';
                return res.json({reply: reply});
            }
            return res.json({reply: '📁 Категории: Дизайн, Разработка, Маркетинг, Копирайтинг, Аудио/Видео, Бизнес-услуги'});
        }

        // Поиск фрилансера по имени
        if (lower.includes('фрилансер') || lower.includes('исполнитель')) {
            const searchName = lower.replace(/фрилансер|исполнитель|покажи|расскажи|о|про/gi, '').trim();

            if (searchName && searchName.length > 2) {
                const freelancer = await new Promise((resolve) => {
                    db.get(`
                        SELECT id, full_name, specialization, rating, completed_projects, bio, avatar_url
                        FROM users
                        WHERE (role IN ('freelancer', 'both'))
                          AND (full_name LIKE ? OR specialization LIKE ?) LIMIT 1
                    `, [`%${searchName}%`, `%${searchName}%`], (err, row) => {
                        resolve(row);
                    });
                });

                if (freelancer) {
                    const stars = '⭐'.repeat(Math.floor(freelancer.rating || 0));
                    let reply = `👨‍💼 **${freelancer.full_name}**\n\n`;
                    reply += `📌 Специализация: ${freelancer.specialization || 'Фрилансер'}\n`;
                    reply += `⭐ Рейтинг: ${freelancer.rating || 0} ${stars}\n`;
                    reply += `✅ Выполнено проектов: ${freelancer.completed_projects || 0}\n\n`;
                    if (freelancer.bio) {
                        reply += `📝 О себе: ${freelancer.bio.substring(0, 200)}${freelancer.bio.length > 200 ? '...' : ''}\n\n`;
                    }
                    reply += `🔗 Посмотреть профиль: /profile/${freelancer.id}`;
                    return res.json({reply: reply});
                }
            }

            // Если не нашли конкретного, показываем топ-3
            const top3 = await new Promise((resolve) => {
                db.all(`
                    SELECT full_name, specialization, rating
                    FROM users
                    WHERE role IN ('freelancer', 'both')
                    ORDER BY rating DESC LIMIT 3
                `, (err, rows) => {
                    resolve(rows || []);
                });
            });

            let reply = '👨‍💻 **Лучшие фрилансеры платформы:**\n\n';
            top3.forEach((f, i) => {
                reply += `${i + 1}. **${f.full_name}** — ${f.specialization || 'фрилансер'} (⭐ ${f.rating || 0})\n`;
            });
            reply += '\n💡 Чтобы узнать о конкретном фрилансере, напишите: "расскажи о [имя]"';
            return res.json({reply: reply});
        }

        // Поиск услуги
        if (lower.includes('услуг') || lower.includes('ворк') || lower.includes('найти')) {
            const searchTerm = lower.replace(/услуг|ворк|найти|покажи|подбери/gi, '').trim();

            if (searchTerm && searchTerm.length > 2) {
                const works = await new Promise((resolve) => {
                    db.all(`
                        SELECT w.title, w.price_from, u.full_name as seller_name
                        FROM works w
                                 JOIN users u ON w.seller_id = u.id
                        WHERE w.is_active = 1
                          AND (w.title LIKE ? OR w.description LIKE ?) LIMIT 3
                    `, [`%${searchTerm}%`, `%${searchTerm}%`], (err, rows) => {
                        resolve(rows || []);
                    });
                });

                if (works.length > 0) {
                    let reply = `🔍 **Найденные услуги по запросу "${searchTerm}":**\n\n`;
                    works.forEach(work => {
                        reply += `• **${work.title}** — от ${work.price_from} ₽\n`;
                        reply += `  👤 Продавец: ${work.seller_name}\n\n`;
                    });
                    reply += '➡️ Хотите заказать? Перейдите в каталог услуг!';
                    return res.json({reply: reply});
                }
            }
        }

        // Остальные fallback ответы
        if (lower.includes('привет') || lower.includes('здравствуй')) {
            return res.json({reply: '👋 Привет! Я ИИ-ассистент Ворк.Тап. Могу помочь найти фрилансера, подобрать услугу, ответить на вопросы. Введите /help для списка команд!'});
        }

        if (lower.includes('баланс') && userId) {
            const balance = await new Promise((resolve) => {
                db.get('SELECT balance FROM wallets WHERE user_id = ?', [userId], (err, row) => {
                    resolve(row ? row.balance : 0);
                });
            });
            return res.json({reply: `💰 Ваш баланс: ${balance} ₽\n\n💳 Пополнить баланс можно в разделе "Кошелёк". Минимальная сумма пополнения — 100 ₽.`});
        }

        if (lower.includes('заказ') || lower.includes('создать заказ')) {
            return res.json({reply: '📝 **Как создать заказ:**\n\n1. Нажмите кнопку "Создать заказ"\n2. Заполните название, категорию, бюджет и описание\n3. Укажите срок выполнения\n4. Опубликуйте — фрилансеры начнут откликаться\n\n💰 Совет: чем подробнее ТЗ, тем качественнее будут отклики!'});
        }

        if (lower.includes('помощь') || lower === '/help') {
            return res.json({reply: '💡 **Доступные команды:**\n\n/top — топовые услуги\n/freelancers — лучшие фрилансеры\n/categories — все категории\n/balance — мой баланс (если авторизован)\n/help — эта справка\n\n✏️ Также можете просто задать вопрос или написать имя фрилансера!'});
        }

        return res.json({reply: '😊 Я могу помочь вам с:\n\n• Поиском фрилансера или услуги\n• Созданием заказа\n• Вопросами по оплате и выводу\n• Советами по ценообразованию\n\n🔍 Просто спросите! Или введите /help для списка команд.'});

    } catch (error) {
        console.error('Ошибка в чате:', error);
        res.json({reply: '😔 Извините, произошла ошибка. Попробуйте позже или напишите нам в поддержку.'});
    }
});

// Глобальные переменные для шаблонов
app.use(async (req, res, next) => {
    res.locals.user = req.session.user || null;
    res.locals.isAuthenticated = req.session.user ? true : false;
    res.locals.isClient = roleAllows(req.session.user, ['client']);
    res.locals.isFreelancer = roleAllows(req.session.user, ['freelancer']);
    res.locals.isAdmin = req.session.user?.role === 'admin';
    res.locals.currentPath = req.path;

    // Получаем категории для навигации
    await new Promise((resolve) => {
        db.all('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order LIMIT 7', (err, rows) => {
            res.locals.categories = rows || [];
            resolve();
        });
    });
    next();
});

// =====================================================
// СТРАНИЦЫ (RENDER EJS)
// =====================================================

// Главная страница
app.get('/', async (req, res) => {
    try {
        const works = await new Promise((resolve) => {
            db.all(`
                SELECT w.*,
                       u.full_name   as seller_name,
                       u.rating      as seller_rating,
                       u.avatar_url  as seller_avatar,
                       c.name        as category_name,
                       MIN(wp.price) as price
                FROM works w
                         JOIN users u ON w.seller_id = u.id
                         JOIN categories c ON w.category_id = c.id
                         LEFT JOIN work_packages wp ON wp.work_id = w.id
                WHERE w.is_active = 1
                GROUP BY w.id
                ORDER BY w.created_at DESC LIMIT 6
            `, (err, rows) => {
                resolve((rows || []).map(normalizeWorkCard));
            });
        });

        const topFreelancers = await new Promise((resolve) => {
            db.all(`
                SELECT id, full_name, specialization, rating, completed_projects, avatar_url
                FROM users
                WHERE role IN ('freelancer', 'both')
                ORDER BY rating DESC, completed_projects DESC LIMIT 6
            `, (err, rows) => {
                resolve(rows || []);
            });
        });

        const allCategories = await new Promise((resolve) => {
            db.all('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order', (err, rows) => {
                resolve(rows || []);
            });
        });
        const favoriteWorkIds = await getFavoriteWorkIds(req.session.user?.id);

        res.render('index', {
            works,
            topFreelancers,
            categories: allCategories,
            favoriteWorkIds,
            title: 'Ворк.Тап — маркетплейс фриланс-услуг'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Биржа проектов
app.get('/market', async (req, res) => {
    try {
        const {category, status, min_budget, max_budget, search, page = 1} = req.query;
        const limit = 10;
        const offset = (page - 1) * limit;

        let query = `
            SELECT p.*,
                   c.name as category_name,
                   u.full_name as client_name,
                   COUNT(b.id) as bids_count
            FROM projects p
                     JOIN categories c ON p.category_id = c.id
                     JOIN users u ON p.client_id = u.id
                     LEFT JOIN bids b ON b.project_id = p.id
            WHERE 1 = 1
        `;
        const params = [];

        if (category && category !== 'all') {
            query += ' AND p.category_id = ?';
            params.push(category);
        }

        if (status && status !== 'all') {
            query += ' AND p.status = ?';
            params.push(status);
        }

        if (min_budget) {
            query += ' AND p.budget >= ?';
            params.push(min_budget);
        }

        if (max_budget) {
            query += ' AND p.budget <= ?';
            params.push(max_budget);
        }

        if (search) {
            query += ' AND (p.title LIKE ? OR p.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ' GROUP BY p.id ORDER BY p.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const projects = await new Promise((resolve) => {
            db.all(query, params, (err, rows) => {
                resolve(rows || []);
            });
        });

        const total = await new Promise((resolve) => {
            let countQuery = `SELECT COUNT(*) as count
                              FROM projects p
                              WHERE 1=1`;
            const countParams = [];
            if (category && category !== 'all') {
                countQuery += ' AND p.category_id = ?';
                countParams.push(category);
            }
            if (status && status !== 'all') {
                countQuery += ' AND p.status = ?';
                countParams.push(status);
            }
            if (search) {
                countQuery += ' AND (p.title LIKE ? OR p.description LIKE ?)';
                countParams.push(`%${search}%`, `%${search}%`);
            }
            db.get(countQuery, countParams, (err, row) => {
                resolve(row ? row.count : 0);
            });
        });

        const categories = await new Promise((resolve) => {
            db.all('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order', (err, rows) => {
                resolve(rows || []);
            });
        });

        res.render('market', {
            projects,
            categories,
            total: total,
            currentPage: parseInt(page),
            limit,
            filters: {category, status, min_budget, max_budget, search},
            title: 'Ворк.Тап — Биржа проектов'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Страница ворков (список)
app.get('/projects/:id', async (req, res) => {
    const projectId = req.params.id;

    try {
        const project = await new Promise((resolve) => {
            db.get(`
                SELECT p.*,
                       c.name as category_name,
                       u.full_name as client_name,
                       u.avatar_url as client_avatar,
                       selected.full_name as freelancer_name
                FROM projects p
                         JOIN categories c ON p.category_id = c.id
                         JOIN users u ON p.client_id = u.id
                         LEFT JOIN users selected ON selected.id = p.selected_freelancer_id
                WHERE p.id = ?
            `, [projectId], (err, row) => resolve(row));
        });

        if (!project) {
            return res.status(404).send('Проект не найден');
        }

        const bids = await new Promise((resolve) => {
            db.all(`
                SELECT b.*, u.full_name as freelancer_name, u.rating, u.completed_projects, u.avatar_url
                FROM bids b
                         JOIN users u ON b.freelancer_id = u.id
                WHERE b.project_id = ?
                ORDER BY b.status = 'accepted' DESC, b.amount ASC, b.created_at DESC
            `, [projectId], (err, rows) => resolve(rows || []));
        });

        const currentUserId = req.session.user ? req.session.user.id : null;
        const userBid = currentUserId
            ? bids.find(bid => bid.freelancer_id === currentUserId)
            : null;

        res.render('project', {
            project,
            bids,
            userBid,
            isOwner: currentUserId && currentUserId === project.client_id,
            title: `${project.title} — Ворк.Тап`
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/works', async (req, res) => {
    try {
        const {category, search, page = 1} = req.query;
        const limit = 12;
        const offset = (page - 1) * limit;

        let query = `
            SELECT w.*,
                   u.full_name   as seller_name,
                   u.rating      as seller_rating,
                   u.avatar_url  as seller_avatar,
                   c.name        as category_name,
                   MIN(wp.price) as price
            FROM works w
                     JOIN users u ON w.seller_id = u.id
                     JOIN categories c ON w.category_id = c.id
                     LEFT JOIN work_packages wp ON wp.work_id = w.id
            WHERE w.is_active = 1
        `;
        const params = [];

        if (category) {
            query += ' AND w.category_id = ?';
            params.push(category);
        }

        if (search) {
            query += ' AND (w.title LIKE ? OR w.description LIKE ?)';
            params.push(`%${search}%`, `%${search}%`);
        }

        query += ' GROUP BY w.id ORDER BY w.created_at DESC LIMIT ? OFFSET ?';
        params.push(limit, offset);

        const works = await new Promise((resolve) => {
            db.all(query, params, (err, rows) => {
                resolve((rows || []).map(normalizeWorkCard));
            });
        });

        const total = await new Promise((resolve) => {
            let countQuery = `SELECT COUNT(*) as count
                              FROM works w
                              WHERE w.is_active = 1`;
            const countParams = [];
            if (category) {
                countQuery += ' AND w.category_id = ?';
                countParams.push(category);
            }
            if (search) {
                countQuery += ' AND (w.title LIKE ? OR w.description LIKE ?)';
                countParams.push(`%${search}%`, `%${search}%`);
            }
            db.get(countQuery, countParams, (err, row) => {
                resolve(row ? row.count : 0);
            });
        });

        const categories = await new Promise((resolve) => {
            db.all('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order', (err, rows) => {
                resolve(rows || []);
            });
        });

        res.render('works-list', {
            works,
            categories,
            total,
            currentPage: parseInt(page),
            limit,
            filters: {category, search},
            favoriteWorkIds: await getFavoriteWorkIds(req.session.user?.id),
            title: 'Ворк.Тап — Все ворки'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Страница ворка
app.get('/work/:id', async (req, res) => {
    const workId = req.params.id;

    try {
        const work = await new Promise((resolve) => {
            db.get(`
                SELECT w.*,
                       u.full_name as seller_name,
                       u.avatar_url,
                       u.specialization,
                       u.rating    as seller_rating,
                       u.completed_projects,
                       u.on_site_since,
                       u.id        as seller_id,
                       c.name      as category_name
                FROM works w
                         JOIN users u ON w.seller_id = u.id
                         JOIN categories c ON w.category_id = c.id
                WHERE w.id = ?
                  AND w.is_active = 1
            `, [workId], (err, row) => {
                resolve(row);
            });
        });

        if (!work) {
            return res.status(404).send('Услуга не найдена');
        }

        work.imagesList = parseWorkImages(work.images);

        const packages = await new Promise((resolve) => {
            db.all('SELECT * FROM work_packages WHERE work_id = ? ORDER BY price', [workId], (err, rows) => {
                resolve(rows || []);
            });
        });

        const faqs = await new Promise((resolve) => {
            db.all('SELECT * FROM work_faqs WHERE work_id = ? ORDER BY sort_order', [workId], (err, rows) => {
                resolve(rows || []);
            });
        });

        const reviews = await new Promise((resolve) => {
            db.all(`
                SELECT r.*, u.full_name as reviewer_name, u.avatar_url
                FROM reviews r
                         JOIN users u ON r.from_user_id = u.id
                WHERE r.work_id = ?
                ORDER BY r.created_at DESC LIMIT 10
            `, [workId], (err, rows) => {
                resolve(rows || []);
            });
        });

        res.render('work', {
            work,
            packages,
            faqs,
            reviews,
            isFavoriteWork: (await getFavoriteWorkIds(req.session.user?.id)).includes(Number(workId)),
            title: `${work.title} — Ворк.Тап`
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/seller/works', async (req, res) => {
    if (!requireRolePage(req, res, ['freelancer'])) return;

    try {
        const userId = req.session.user.id;
        const works = await new Promise((resolve) => {
            db.all(`
                SELECT w.*,
                       c.name as category_name,
                       MIN(wp.price) as price
                FROM works w
                         JOIN categories c ON c.id = w.category_id
                         LEFT JOIN work_packages wp ON wp.work_id = w.id
                WHERE w.seller_id = ?
                GROUP BY w.id
                ORDER BY w.created_at DESC
            `, [userId], (err, rows) => resolve((rows || []).map(normalizeWorkCard)));
        });

        res.render('seller-works', {works, title: 'Мои ворки — Ворк.Тап'});
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/seller/works/new', async (req, res) => {
    if (!requireRolePage(req, res, ['freelancer'])) return;

    const categories = await new Promise((resolve) => {
        db.all('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order', (err, rows) => {
            resolve(rows || []);
        });
    });

    res.render('create-work', {categories, title: 'Создать ворк — Ворк.Тап'});
});

// Мои заказы
app.get('/my-tasks', async (req, res) => {
    if (!requireRolePage(req, res, ['client'])) return;

    try {
        const userId = req.session.user.id;

        const orders = await new Promise((resolve) => {
            db.all(`
                SELECT p.*,
                       c.name                                                            as category_name,
                       (SELECT full_name FROM users WHERE id = p.selected_freelancer_id) as freelancer_name
                FROM projects p
                         JOIN categories c ON p.category_id = c.id
                WHERE p.client_id = ?
                ORDER BY p.created_at DESC
            `, [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        for (const order of orders) {
            order.bids = await new Promise((resolve) => {
                db.all(`
                    SELECT b.*, u.full_name as freelancer_name, u.rating, u.avatar_url
                    FROM bids b
                             JOIN users u ON b.freelancer_id = u.id
                    WHERE b.project_id = ?
                    ORDER BY b.amount
                `, [order.id], (err, rows) => {
                    resolve(rows || []);
                });
            });
        }

        res.render('my-tasks', {
            orders,
            title: 'Ворк.Тап — Мои заказы'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Профиль
app.get('/profile/:id?', async (req, res) => {
    const userId = req.params.id || (req.session.user ? req.session.user.id : null);

    if (!userId) {
        return res.redirect('/login');
    }

    try {
        const profile = await new Promise((resolve) => {
            db.get(`
                SELECT id,
                       email,
                       full_name,
                       phone,
                       avatar_url,
                       role,
                       specialization,
                       bio,
                       rating,
                       completed_projects,
                       on_site_since,
                       total_earned
                FROM users
                WHERE id = ?
            `, [userId], (err, row) => {
                resolve(row);
            });
        });

        if (!profile) {
            return res.status(404).send('Пользователь не найден');
        }

        const skills = await new Promise((resolve) => {
            db.all(`
                SELECT s.name, s.id
                FROM skills s
                         JOIN user_skills us ON s.id = us.skill_id
                WHERE us.user_id = ?
            `, [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        const portfolios = await new Promise((resolve) => {
            db.all('SELECT * FROM portfolios WHERE user_id = ?', [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        const reviews = await new Promise((resolve) => {
            db.all(`
                SELECT r.*, u.full_name as reviewer_name, u.avatar_url
                FROM reviews r
                         JOIN users u ON r.from_user_id = u.id
                WHERE r.to_user_id = ?
                ORDER BY r.created_at DESC LIMIT 10
            `, [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        const isOwnProfile = req.session.user && req.session.user.id == userId;

        res.render('profile', {
            profile,
            skills,
            portfolios,
            reviews,
            isOwnProfile,
            title: `${profile.full_name} — Профиль на Ворк.Тап`
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.patch('/api/profile', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const userId = req.session.user.id;
    const {
        full_name,
        email,
        phone,
        avatar_url,
        specialization,
        bio,
        current_password,
        new_password
    } = req.body;

    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedPhone = phone ? String(phone).replace(/[^\d+]/g, '') : null;

    if (!String(full_name || '').trim() || !normalizedEmail) {
        return res.status(400).json({error: 'Имя и email обязательны'});
    }

    if (new_password && String(new_password).length < 6) {
        return res.status(400).json({error: 'Новый пароль должен быть не короче 6 символов'});
    }

    try {
        const currentUser = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => err ? reject(err) : resolve(row));
        });

        if (!currentUser) {
            return res.status(404).json({error: 'Пользователь не найден'});
        }

        const emailChanged = currentUser.email.toLowerCase() !== normalizedEmail;
        const passwordChanged = Boolean(new_password);

        if ((emailChanged || passwordChanged) && !current_password) {
            return res.status(400).json({error: 'Для смены email или пароля введите текущий пароль'});
        }

        if (emailChanged || passwordChanged) {
            const passwordOk = await bcrypt.compare(current_password, currentUser.password_hash);
            if (!passwordOk) {
                return res.status(400).json({error: 'Текущий пароль указан неверно'});
            }
        }

        const existingUser = await new Promise((resolve) => {
            db.get(`
                SELECT id, email, phone
                FROM users
                WHERE id != ?
                  AND (
                    lower(email) = ?
                    OR (? IS NOT NULL AND phone = ?)
                  )
                LIMIT 1
            `, [userId, normalizedEmail, normalizedPhone, normalizedPhone], (err, row) => resolve(row));
        });

        if (existingUser) {
            if (existingUser.email && existingUser.email.toLowerCase() === normalizedEmail) {
                return res.status(400).json({error: 'Email уже используется другим аккаунтом'});
            }
            return res.status(400).json({error: 'Телефон уже используется другим аккаунтом'});
        }

        const fields = [
            'email = ?',
            'full_name = ?',
            'phone = ?',
            'avatar_url = ?',
            'specialization = ?',
            'bio = ?',
            'updated_at = datetime("now")'
        ];
        const params = [
            normalizedEmail,
            String(full_name).trim(),
            normalizedPhone || null,
            String(avatar_url || '').trim() || null,
            String(specialization || '').trim() || null,
            String(bio || '').trim() || null
        ];

        if (passwordChanged) {
            const hash = await bcrypt.hash(new_password, 10);
            fields.push('password_hash = ?');
            params.push(hash);
        }

        params.push(userId);

        await new Promise((resolve, reject) => {
            db.run(`UPDATE users SET ${fields.join(', ')} WHERE id = ?`, params, (err) => err ? reject(err) : resolve());
        });

        const updatedUser = await new Promise((resolve, reject) => {
            db.get('SELECT * FROM users WHERE id = ?', [userId], (err, row) => err ? reject(err) : resolve(row));
        });
        const {password_hash, ...userWithoutPassword} = updatedUser;
        req.session.user = userWithoutPassword;

        res.json({success: true, user: userWithoutPassword});
    } catch (err) {
        console.error(err);
        if (err.message && err.message.includes('UNIQUE')) {
            return res.status(400).json({error: 'Email или телефон уже используется'});
        }
        res.status(500).json({error: err.message});
    }
});

// Кошелек
app.get('/wallet', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const userId = req.session.user.id;

        const wallet = await new Promise((resolve) => {
            db.get('SELECT * FROM wallets WHERE user_id = ?', [userId], (err, row) => {
                resolve(row || {balance: 0, frozen_balance: 0});
            });
        });

        const transactions = await new Promise((resolve) => {
            db.all(`
                SELECT *
                FROM transactions
                WHERE user_id = ?
                ORDER BY created_at DESC LIMIT 50
            `, [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        res.render('wallet', {
            wallet,
            transactions,
            title: 'Ворк.Тап — Кошелёк'
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Фрилансеры
app.get('/freelancers', async (req, res) => {
    try {
        const freelancers = await new Promise((resolve) => {
            db.all(`
                SELECT id, full_name, specialization, rating, completed_projects, avatar_url
                FROM users
                WHERE role IN ('freelancer', 'both')
                ORDER BY rating DESC LIMIT 30
            `, (err, rows) => {
                resolve(rows || []);
            });
        });

        res.render('freelancers', {freelancers, title: 'Фрилансеры — Ворк.Тап'});
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Избранное
app.get('/favorites', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const userId = req.session.user.id;

        const freelancers = await new Promise((resolve) => {
            db.all(`
                SELECT u.id, u.full_name, u.specialization, u.rating, u.completed_projects, u.avatar_url
                FROM favorites f
                         JOIN users u ON f.freelancer_id = u.id
                WHERE f.user_id = ?
                  AND f.freelancer_id IS NOT NULL
            `, [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        const works = await new Promise((resolve) => {
            db.all(`
                SELECT w.*, u.full_name as seller_name, u.avatar_url as seller_avatar, MIN(wp.price) as price
                FROM favorites f
                         JOIN works w ON f.work_id = w.id
                         JOIN users u ON w.seller_id = u.id
                         LEFT JOIN work_packages wp ON wp.work_id = w.id
                WHERE f.user_id = ?
                  AND f.work_id IS NOT NULL
                GROUP BY w.id
            `, [userId], (err, rows) => {
                resolve((rows || []).map(normalizeWorkCard));
            });
        });

        res.render('favorites', {freelancers, works, title: 'Избранное — Ворк.Тап'});
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Сообщения
app.get('/messages', async (req, res) => {
    if (!req.session.user) {
        return res.redirect('/login');
    }

    try {
        const userId = req.session.user.id;

        const conversations = await getUserConversations(userId);

        if (req.query.user) {
            const targetUserId = Number(req.query.user);
            if (targetUserId && targetUserId !== userId) {
                const targetUser = await new Promise((resolve) => {
                    db.get('SELECT id as user_id, full_name FROM users WHERE id = ?', [targetUserId], (err, row) => resolve(row));
                });
                if (targetUser) {
                    const existingIndex = conversations.findIndex(conv => Number(conv.user_id) === targetUserId);
                    const existing = existingIndex >= 0 ? conversations.splice(existingIndex, 1)[0] : null;
                    conversations.unshift({
                        ...targetUser,
                        last_message: existing?.last_message || 'Новый диалог'
                    });
                }
            }
        }

        res.render('messages', {conversations, selectedUserId: req.query.user || null, title: 'Сообщения — Ворк.Тап'});
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Создать заказ (страница)
app.get('/create-order', async (req, res) => {
    if (!requireRolePage(req, res, ['client'])) return;

    const categories = await new Promise((resolve) => {
        db.all('SELECT * FROM categories WHERE parent_id IS NULL ORDER BY sort_order', (err, rows) => {
            resolve(rows || []);
        });
    });

    res.render('create-order', {categories, title: 'Создать заказ — Ворк.Тап'});
});

// Логин
app.get('/login', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('login', {title: 'Вход — Ворк.Тап'});
});

// Регистрация
app.get('/register', (req, res) => {
    if (req.session.user) {
        return res.redirect('/');
    }
    res.render('register', {title: 'Регистрация — Ворк.Тап'});
});

// Выход
app.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// =====================================================
// API ЭНДПОИНТЫ
// =====================================================

// Регистрация
app.post('/api/register', async (req, res) => {
    const {email, password, full_name, phone, role} = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();
    const normalizedPhone = phone ? String(phone).replace(/[^\d+]/g, '') : null;
    const normalizedRole = ['client', 'freelancer'].includes(role) ? role : 'client';

    console.log('Регистрация:', {email, full_name, phone, role});

    if (!normalizedEmail || !password || !full_name) {
        return res.status(400).json({error: 'Заполните все обязательные поля'});
    }

    try {
        const existingUser = await new Promise((resolve) => {
            db.get(`
                SELECT id, email, phone
                FROM users
                WHERE lower(email) = ?
                   OR (? IS NOT NULL AND phone = ?)
            `, [normalizedEmail, normalizedPhone, normalizedPhone], (err, row) => resolve(row));
        });

        if (existingUser) {
            if (existingUser.email && existingUser.email.toLowerCase() === normalizedEmail) {
                return res.status(400).json({error: 'Email уже зарегистрирован'});
            }
            return res.status(400).json({error: 'Телефон уже зарегистрирован'});
        }

        const hashedPassword = await bcrypt.hash(password, 10);

        db.run(`
            INSERT INTO users (email, password_hash, full_name, phone, role, on_site_since)
            VALUES (?, ?, ?, ?, ?, date ('now'))
        `, [normalizedEmail, hashedPassword, full_name.trim(), normalizedPhone || null, normalizedRole], function (err) {
            if (err) {
                console.error('Ошибка БД:', err.message);
                if (err.message.includes('UNIQUE')) {
                    return res.status(400).json({error: 'Email уже зарегистрирован'});
                }
                return res.status(500).json({error: err.message});
            }

            const userId = this.lastID;

            db.run('INSERT INTO wallets (user_id, balance, frozen_balance) VALUES (?, 0, 0)', userId);

            console.log('Пользователь создан, ID:', userId);
            res.json({success: true, userId: userId});
        });
    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({error: err.message});
    }
});

// Авторизация
app.post('/api/login', (req, res) => {
    const {email, password} = req.body;
    const normalizedEmail = String(email || '').trim().toLowerCase();

    console.log('Вход:', email);

    db.get('SELECT * FROM users WHERE lower(email) = ?', [normalizedEmail], async (err, user) => {
        if (err) {
            console.error('Ошибка БД:', err);
            return res.status(500).json({error: err.message});
        }

        if (!user) {
            console.log('Пользователь не найден');
            return res.status(401).json({error: 'Неверный email или пароль'});
        }

        if (user.is_active === 0) {
            return res.status(403).json({error: 'Аккаунт заблокирован администратором'});
        }

        const isValid = await bcrypt.compare(password, user.password_hash);
        if (!isValid) {
            console.log('Неверный пароль');
            return res.status(401).json({error: 'Неверный email или пароль'});
        }

        const {password_hash, ...userWithoutPassword} = user;
        req.session.user = userWithoutPassword;

        console.log('Вход выполнен:', userWithoutPassword.email);
        res.json({success: true, user: userWithoutPassword});
    });
});

// Получить текущего пользователя
app.get('/api/me', (req, res) => {
    if (req.session.user) {
        res.json(req.session.user);
    } else {
        res.status(401).json({error: 'Не авторизован'});
    }
});

// Получить проекты (API)
app.get('/api/projects', (req, res) => {
    const {limit = 10, offset = 0} = req.query;

    db.all(`
        SELECT p.*, c.name as category_name, u.full_name as client_name
        FROM projects p
                 JOIN categories c ON p.category_id = c.id
                 JOIN users u ON p.client_id = u.id
        ORDER BY p.created_at DESC LIMIT ?
        OFFSET ?
    `, [limit, offset], (err, rows) => {
        if (err) {
            return res.status(500).json({error: err.message});
        }
        res.json(rows);
    });
});

// Создать проект
app.post('/api/projects/:id/bids', async (req, res) => {
    if (!requireRoleApi(req, res, ['freelancer'])) return;

    const projectId = req.params.id;
    const freelancerId = req.session.user.id;
    const {amount, delivery_days, comment} = req.body;

    if (!amount || !delivery_days || Number(amount) <= 0 || Number(delivery_days) <= 0) {
        return res.status(400).json({error: 'Укажите сумму и срок выполнения'});
    }

    try {
        const project = await new Promise((resolve) => {
            db.get('SELECT * FROM projects WHERE id = ?', [projectId], (err, row) => resolve(row));
        });

        if (!project) return res.status(404).json({error: 'Проект не найден'});
        if (project.status !== 'open') return res.status(400).json({error: 'Проект уже не принимает отклики'});
        if (project.client_id === freelancerId) return res.status(400).json({error: 'Нельзя откликнуться на свой проект'});

        const existingBid = await new Promise((resolve) => {
            db.get('SELECT id FROM bids WHERE project_id = ? AND freelancer_id = ?', [projectId, freelancerId], (err, row) => resolve(row));
        });

        if (existingBid) {
            return res.status(400).json({error: 'Вы уже откликались на этот проект'});
        }

        const bidId = await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO bids (project_id, freelancer_id, amount, delivery_days, comment, status, created_at)
                VALUES (?, ?, ?, ?, ?, 'pending', datetime('now'))
            `, [projectId, freelancerId, amount, delivery_days, comment || null], function (err) {
                if (err) reject(err);
                else resolve(this.lastID);
            });
        });

        db.run(`
            INSERT INTO notifications (user_id, type, title, message, link, created_at)
            VALUES (?, 'bid_new', 'Новый отклик', 'Исполнитель оставил отклик на ваш проект', ?, datetime('now'))
        `, [project.client_id, `/projects/${projectId}`]);

        res.json({success: true, bidId});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.post('/api/projects/:projectId/bids/:bidId/accept', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const {projectId, bidId} = req.params;
    const clientId = req.session.user.id;

    try {
        const bid = await new Promise((resolve) => {
            db.get(`
                SELECT b.*, p.client_id, p.status as project_status
                FROM bids b
                         JOIN projects p ON p.id = b.project_id
                WHERE b.id = ? AND b.project_id = ?
            `, [bidId, projectId], (err, row) => resolve(row));
        });

        if (!bid) return res.status(404).json({error: 'Отклик не найден'});
        if (bid.client_id !== clientId) return res.status(403).json({error: 'Можно выбрать исполнителя только для своего проекта'});
        if (bid.project_status !== 'open') return res.status(400).json({error: 'Проект уже в работе или закрыт'});

        await new Promise((resolve, reject) => {
            db.run(`
                UPDATE projects
                SET status = 'in_progress',
                    selected_freelancer_id = ?,
                    updated_at = datetime('now')
                WHERE id = ?
            `, [bid.freelancer_id, projectId], (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve, reject) => {
            db.run(`UPDATE bids SET status = CASE WHEN id = ? THEN 'accepted' ELSE 'rejected' END WHERE project_id = ?`,
                [bidId, projectId], (err) => err ? reject(err) : resolve());
        });

        db.run(`
            INSERT INTO notifications (user_id, type, title, message, link, created_at)
            VALUES (?, 'bid_accepted', 'Отклик принят', 'Заказчик выбрал вас исполнителем проекта', ?, datetime('now'))
        `, [bid.freelancer_id, `/projects/${projectId}`]);

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.post('/api/projects/:id/cancel', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const projectId = req.params.id;
    if (!roleAllows(req.session.user, ['client'])) {
        return res.status(403).json({error: 'Действие доступно только заказчику'});
    }

    const userId = req.session.user.id;

    try {
        const project = await new Promise((resolve) => {
            db.get('SELECT * FROM projects WHERE id = ?', [projectId], (err, row) => resolve(row));
        });

        if (!project) return res.status(404).json({error: 'Проект не найден'});
        if (project.client_id !== userId) return res.status(403).json({error: 'Можно отменить только свой проект'});
        if (project.status === 'completed' || project.status === 'cancelled') {
            return res.status(400).json({error: 'Проект уже закрыт'});
        }

        await new Promise((resolve, reject) => {
            db.run(`UPDATE projects SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
                [projectId], (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve, reject) => {
            db.run(`UPDATE bids SET status = 'rejected' WHERE project_id = ? AND status = 'pending'`,
                [projectId], (err) => err ? reject(err) : resolve());
        });

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.post('/api/projects', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    if (!roleAllows(req.session.user, ['client'])) {
        return res.status(403).json({error: 'Действие доступно только заказчику'});
    }

    const {title, category_id, budget, deadline, description} = req.body;
    const client_id = req.session.user.id;

    if (!title || !category_id || !budget || !description) {
        return res.status(400).json({error: 'Заполните все обязательные поля'});
    }

    db.run(`
        INSERT INTO projects (client_id, category_id, title, description, budget, deadline, status, created_at)
        VALUES (?, ?, ?, ?, ?, ?, 'open', datetime('now'))
    `, [client_id, category_id, title, description, budget, deadline || null], function (err) {
        if (err) {
            console.error('Ошибка создания проекта:', err);
            return res.status(500).json({error: err.message});
        }

        res.json({success: true, projectId: this.lastID});
    });
});

app.post('/api/works', async (req, res) => {
    if (!requireRoleApi(req, res, ['freelancer'])) return;

    const {title, category_id, description, requirements, images, packages} = req.body;
    const sellerId = req.session.user.id;
    const safePackages = Array.isArray(packages) ? packages : [];

    if (!title || !category_id || !description) {
        return res.status(400).json({error: 'Заполните название, категорию и описание ворка'});
    }

    const validPackages = safePackages
        .filter(pkg => pkg && pkg.name && Number(pkg.price) > 0)
        .slice(0, 3)
        .map((pkg, index) => ({
            name: ['econom', 'standard', 'business'].includes(pkg.name) ? pkg.name : `package-${index + 1}`,
            price: Number(pkg.price),
            description: String(pkg.description || '').trim(),
            delivery_days: Math.max(1, Number(pkg.delivery_days) || 1),
            features: Array.isArray(pkg.features)
                ? pkg.features.map(item => String(item).trim()).filter(Boolean).slice(0, 8)
                : String(pkg.features || '').split('\n').map(item => item.trim()).filter(Boolean).slice(0, 8),
            sort_order: index + 1
        }));

    if (!validPackages.length) {
        return res.status(400).json({error: 'Добавьте хотя бы один пакет с ценой'});
    }

    const imageList = Array.isArray(images)
        ? images.map(item => String(item).trim()).filter(Boolean).slice(0, 5)
        : String(images || '').split('\n').map(item => item.trim()).filter(Boolean).slice(0, 5);

    try {
        const slug = `${makeSlug(title)}-${crypto.randomBytes(3).toString('hex')}`;
        const workId = await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO works (seller_id, category_id, title, slug, description, requirements, images, is_active, created_at, updated_at)
                VALUES (?, ?, ?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))
            `, [
                sellerId,
                category_id,
                String(title).trim(),
                slug,
                String(description).trim(),
                String(requirements || '').trim(),
                JSON.stringify(imageList)
            ], function (err) {
                err ? reject(err) : resolve(this.lastID);
            });
        });

        for (const pkg of validPackages) {
            await new Promise((resolve, reject) => {
                db.run(`
                    INSERT INTO work_packages (work_id, name, price, description, delivery_days, features, sort_order)
                    VALUES (?, ?, ?, ?, ?, ?, ?)
                `, [
                    workId,
                    pkg.name,
                    pkg.price,
                    pkg.description,
                    pkg.delivery_days,
                    JSON.stringify(pkg.features),
                    pkg.sort_order
                ], (err) => err ? reject(err) : resolve());
            });
        }

        res.json({success: true, workId});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

// Пополнение баланса
app.get('/api/wallet', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const userId = req.session.user.id;
    const wallet = await new Promise((resolve) => {
        db.get('SELECT * FROM wallets WHERE user_id = ?', [userId], (err, row) => {
            resolve(row || {balance: 0, frozen_balance: 0});
        });
    });

    res.json({wallet});
});

app.post('/api/wallet/deposit', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const {amount, payment_method} = req.body;
    const userId = req.session.user.id;
    const hash = crypto.randomBytes(16).toString('hex');

    if (amount < 100) {
        return res.status(400).json({error: 'Минимальная сумма пополнения 100 ₽'});
    }

    db.run(`
        INSERT INTO transactions (user_id, transaction_hash, type, amount, status, payment_method, description,
                                  created_at)
        VALUES (?, ?, 'deposit', ?, 'completed', ?, 'Пополнение баланса', datetime('now'))
    `, [userId, hash, amount, payment_method], function (err) {
        if (err) {
            return res.status(500).json({error: err.message});
        }

        db.run('UPDATE wallets SET balance = balance + ?, updated_at = datetime("now") WHERE user_id = ?', [amount, userId]);

        res.json({success: true, transactionId: this.lastID, hash});
    });
});

// Обновить статус проекта
app.patch('/api/projects/:id/status', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const {status} = req.body;
    const projectId = req.params.id;

    db.run(`
        UPDATE projects
        SET status     = ?,
            updated_at = datetime('now')
        WHERE id = ?
    `, [status, projectId], function (err) {
        if (err) {
            return res.status(500).json({error: err.message});
        }

        res.json({success: true});
    });
});

// Добавить в избранное
app.post('/api/favorites', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const {freelancer_id, work_id} = req.body;
    const user_id = req.session.user.id;

    if (!freelancer_id && !work_id) {
        return res.status(400).json({error: 'Не передан объект избранного'});
    }

    const lookupQuery = work_id
        ? 'SELECT id FROM favorites WHERE user_id = ? AND work_id = ?'
        : 'SELECT id FROM favorites WHERE user_id = ? AND freelancer_id = ?';
    const lookupId = work_id || freelancer_id;

    db.get(lookupQuery, [user_id, lookupId], (lookupErr, existing) => {
        if (lookupErr) return res.status(500).json({error: lookupErr.message});
        if (existing) return res.json({success: true, alreadyExists: true});

        db.run(`
            INSERT INTO favorites (user_id, freelancer_id, work_id, created_at)
            VALUES (?, ?, ?, datetime('now'))
        `, [user_id, freelancer_id || null, work_id || null], function (err) {
            if (err) {
                return res.status(500).json({error: err.message});
            }
            res.json({success: true});
        });
    });
});

app.post('/api/portfolio', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const {title, description, image_url, project_url} = req.body;
    if (!String(title || '').trim()) {
        return res.status(400).json({error: 'Укажите название работы'});
    }

    db.run(`
        INSERT INTO portfolios (user_id, title, description, image_url, project_url, created_at)
        VALUES (?, ?, ?, ?, ?, datetime('now'))
    `, [
        req.session.user.id,
        String(title).trim(),
        String(description || '').trim() || null,
        String(image_url || '').trim() || null,
        String(project_url || '').trim() || null
    ], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true, portfolioId: this.lastID});
    });
});

app.delete('/api/portfolio/:id', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    db.run('DELETE FROM portfolios WHERE id = ? AND user_id = ?', [req.params.id, req.session.user.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        if (this.changes === 0) return res.status(404).json({error: 'Работа не найдена'});
        res.json({success: true});
    });
});

// Удалить из избранного
app.delete('/api/favorites/remove', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const {type, id} = req.body;
    const userId = req.session.user.id;

    let query = '';
    if (type === 'freelancer') {
        query = 'DELETE FROM favorites WHERE user_id = ? AND freelancer_id = ?';
    } else if (type === 'work') {
        query = 'DELETE FROM favorites WHERE user_id = ? AND work_id = ?';
    } else {
        return res.status(400).json({error: 'Неверный тип'});
    }

    db.run(query, [userId, id], function (err) {
        if (err) {
            return res.status(500).json({error: err.message});
        }
        res.json({success: true});
    });
});

function saveChatAttachments(messageId, attachments) {
    const safeAttachments = Array.isArray(attachments) ? attachments.slice(0, 5) : [];
    const allowedTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

    return Promise.all(safeAttachments.map((attachment) => new Promise((resolve, reject) => {
        const dataUrl = String(attachment.dataUrl || '');
        const match = dataUrl.match(/^data:(image\/(?:jpeg|png|webp|gif));base64,(.+)$/);
        if (!match) return reject(new Error('Можно отправлять только изображения JPG, PNG, WEBP или GIF'));

        const mimeType = match[1];
        if (!allowedTypes.has(mimeType)) return reject(new Error('Неподдерживаемый формат изображения'));

        const bytes = Buffer.from(match[2], 'base64');
        if (bytes.length > 5 * 1024 * 1024) return reject(new Error('Одно изображение не должно быть больше 5 МБ'));

        const ext = mimeType === 'image/jpeg' ? 'jpg' : mimeType.split('/')[1];
        const fileName = `${messageId}-${crypto.randomBytes(8).toString('hex')}.${ext}`;
        const relativePath = `/uploads/chat/${fileName}`;
        fs.writeFile(path.join(chatUploadDir, fileName), bytes, (writeErr) => {
            if (writeErr) return reject(writeErr);

            db.run(`
                INSERT INTO message_attachments (message_id, file_path, file_name, mime_type, size, created_at)
                VALUES (?, ?, ?, ?, ?, datetime('now'))
            `, [messageId, relativePath, attachment.name || fileName, mimeType, bytes.length], (dbErr) => {
                dbErr ? reject(dbErr) : resolve();
            });
        });
    })));
}

app.get('/api/conversations', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const userId = req.session.user.id;
    const conversations = await getUserConversations(userId);

    if (req.query.user) {
        const targetUserId = Number(req.query.user);
        if (targetUserId && targetUserId !== userId) {
            const targetUser = await new Promise((resolve) => {
                db.get('SELECT id as user_id, full_name FROM users WHERE id = ?', [targetUserId], (err, row) => resolve(row));
            });
            if (targetUser) {
                const existingIndex = conversations.findIndex(conv => Number(conv.user_id) === targetUserId);
                const existing = existingIndex >= 0 ? conversations.splice(existingIndex, 1)[0] : null;
                conversations.unshift({
                    ...targetUser,
                    last_message: existing?.last_message || 'Новый диалог'
                });
            }
        }
    }

    res.json(conversations);
});

// Получить сообщения
app.get('/api/messages/:userId', (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const currentUserId = req.session.user.id;
    const otherUserId = req.params.userId;

    db.all(`
        SELECT *
        FROM messages
        WHERE (from_user_id = ? AND to_user_id = ?)
           OR (from_user_id = ? AND to_user_id = ?)
        ORDER BY created_at ASC
    `, [currentUserId, otherUserId, otherUserId, currentUserId], (err, rows) => {
        if (err) return res.status(500).json({error: err.message});

        if (!rows.length) return res.json([]);

        const ids = rows.map(row => row.id);
        db.all(`
            SELECT *
            FROM message_attachments
            WHERE message_id IN (${ids.map(() => '?').join(',')})
            ORDER BY id ASC
        `, ids, (attachmentsErr, attachments) => {
            if (attachmentsErr) return res.status(500).json({error: attachmentsErr.message});

            const byMessage = {};
            (attachments || []).forEach(file => {
                if (!byMessage[file.message_id]) byMessage[file.message_id] = [];
                byMessage[file.message_id].push(file);
            });

            const messages = rows.map(msg => ({
                ...msg,
                is_outgoing: msg.from_user_id === currentUserId,
                attachments: byMessage[msg.id] || []
            }));

            res.json(messages);
        });
    });
});

// Создание заказа (покупка ворка)
app.post('/api/orders', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    if (!roleAllows(req.session.user, ['client'])) {
        return res.status(403).json({error: 'Покупать ворки может только заказчик'});
    }

    const {work_id, package_id, amount, requirements, payment_method} = req.body;
    const buyer_id = req.session.user.id;

    if (!work_id || !package_id || !amount) {
        return res.status(400).json({error: 'Недостаточно данных'});
    }

    if (payment_method !== 'wallet') {
        return res.status(400).json({error: 'Заказ можно оплатить только с баланса Ворк.Тап'});
    }

    try {
        // Получаем информацию о ворке и продавце
        const work = await new Promise((resolve) => {
            db.get('SELECT seller_id FROM works WHERE id = ?', [work_id], (err, row) => {
                resolve(row);
            });
        });

        if (!work) {
            return res.status(404).json({error: 'Услуга не найдена'});
        }

        // Если оплата с баланса - списываем средства
        if (payment_method === 'wallet') {
            const wallet = await new Promise((resolve) => {
                db.get('SELECT balance FROM wallets WHERE user_id = ?', [buyer_id], (err, row) => {
                    resolve(row);
                });
            });

            if (!wallet || wallet.balance < amount) {
                return res.status(400).json({error: 'Недостаточно средств на балансе'});
            }

            // Списываем с баланса покупателя
            await new Promise((resolve) => {
                db.run('UPDATE wallets SET balance = balance - ?, frozen_balance = frozen_balance + ? WHERE user_id = ?', [amount, amount, buyer_id], resolve);
            });

            // Создаём транзакции
            const hash = crypto.randomBytes(16).toString('hex');
            await new Promise((resolve) => {
                db.run(`
                    INSERT INTO transactions (user_id, transaction_hash, type, amount, status, description, created_at)
                    VALUES (?, ?, 'payment', ?, 'completed', 'Оплата услуги #' || ?, datetime('now'))
                `, [buyer_id, hash, -amount, work_id], resolve);
            });

        }

        // Создаём заказ
        const orderId = await new Promise((resolve) => {
            db.run(`
                INSERT INTO orders (buyer_id, work_id, package_id, amount, status, requirements, created_at, updated_at)
                VALUES (?, ?, ?, ?, 'paid', ?, datetime('now'), datetime('now'))
            `, [buyer_id, work_id, package_id, amount, requirements || ''], function (err) {
                if (err) {
                    console.error('Ошибка создания заказа:', err);
                    resolve(null);
                } else {
                    resolve(this.lastID);
                }
            });
        });

        if (!orderId) {
            return res.status(500).json({error: 'Ошибка создания заказа'});
        }

        // Создаём уведомление для продавца
        await new Promise((resolve) => {
            db.run(`
                INSERT INTO notifications (user_id, type, title, message, link, created_at)
                VALUES (?, 'order', 'Новый заказ', 'Поступил новый заказ на вашу услугу', '/seller/orders',
                        datetime('now'))
            `, [work.seller_id], resolve);
        });

        res.json({success: true, orderId: orderId});

    } catch (err) {
        console.error('Ошибка:', err);
        res.status(500).json({error: err.message});
    }
});

// Получить заказы пользователя (как покупатель)
app.post('/api/orders/:id/cancel', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const orderId = req.params.id;
    const userId = req.session.user.id;

    try {
        const order = await new Promise((resolve) => {
            db.get(`
                SELECT o.*, w.seller_id
                FROM orders o
                         JOIN works w ON o.work_id = w.id
                WHERE o.id = ?
            `, [orderId], (err, row) => resolve(row));
        });

        if (!order) return res.status(404).json({error: 'Заказ не найден'});
        if (order.buyer_id !== userId) return res.status(403).json({error: 'Можно отменить только свой заказ'});
        if (!['paid', 'pending'].includes(order.status)) {
            return res.status(400).json({error: 'Этот заказ уже нельзя отменить'});
        }

        await new Promise((resolve, reject) => {
            db.run(`UPDATE orders SET status = 'cancelled', updated_at = datetime('now') WHERE id = ?`,
                [orderId], (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve, reject) => {
            db.run('UPDATE wallets SET balance = balance + ?, frozen_balance = MAX(frozen_balance - ?, 0), updated_at = datetime("now") WHERE user_id = ?',
                [order.amount, order.amount, order.buyer_id], (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve) => {
            resolve();
        });

        const hash = crypto.randomBytes(16).toString('hex');
        db.run(`
            INSERT INTO transactions (user_id, transaction_hash, type, amount, status, description, related_entity_type, related_entity_id, created_at)
            VALUES (?, ?, 'refund', ?, 'completed', 'Возврат за отмененный заказ', 'order', ?, datetime('now'))
        `, [order.buyer_id, hash, order.amount, orderId]);

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

async function getOrderWithSeller(orderId) {
    return await new Promise((resolve) => {
        db.get(`
            SELECT o.*, w.seller_id, w.title as work_title
            FROM orders o
                     JOIN works w ON o.work_id = w.id
            WHERE o.id = ?
        `, [orderId], (err, row) => resolve(row));
    });
}

app.post('/api/orders/:id/start', async (req, res) => {
    if (!requireRoleApi(req, res, ['freelancer'])) return;

    const order = await getOrderWithSeller(req.params.id);
    if (!order) return res.status(404).json({error: 'Заказ не найден'});
    if (order.seller_id !== req.session.user.id) return res.status(403).json({error: 'Это не ваш заказ'});
    if (order.status !== 'paid') return res.status(400).json({error: 'Заказ нельзя взять в работу'});

    db.run(`UPDATE orders SET status = 'in_progress', updated_at = datetime('now') WHERE id = ?`, [order.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/orders/:id/deliver', async (req, res) => {
    if (!requireRoleApi(req, res, ['freelancer'])) return;

    const order = await getOrderWithSeller(req.params.id);
    if (!order) return res.status(404).json({error: 'Заказ не найден'});
    if (order.seller_id !== req.session.user.id) return res.status(403).json({error: 'Это не ваш заказ'});
    if (order.status !== 'in_progress') return res.status(400).json({error: 'Сдать можно только заказ в работе'});

    db.run(`UPDATE orders SET status = 'delivered', updated_at = datetime('now') WHERE id = ?`, [order.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/orders/:id/complete', async (req, res) => {
    if (!requireRoleApi(req, res, ['client'])) return;

    const order = await getOrderWithSeller(req.params.id);
    if (!order) return res.status(404).json({error: 'Заказ не найден'});
    if (order.buyer_id !== req.session.user.id) return res.status(403).json({error: 'Это не ваш заказ'});
    if (order.status !== 'delivered') return res.status(400).json({error: 'Подтвердить можно только сданный заказ'});

    try {
        await new Promise((resolve, reject) => {
            db.run(`UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?`,
                [order.id], (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve) => {
            db.run('UPDATE wallets SET frozen_balance = MAX(frozen_balance - ?, 0), updated_at = datetime("now") WHERE user_id = ?',
                [order.amount, order.buyer_id], resolve);
        });

        await new Promise((resolve) => {
            db.run('UPDATE wallets SET balance = balance + ?, updated_at = datetime("now") WHERE user_id = ?',
                [order.amount, order.seller_id], resolve);
        });

        await new Promise((resolve) => {
            db.run('UPDATE users SET total_spent = total_spent + ? WHERE id = ?', [order.amount, order.buyer_id], resolve);
        });

        await new Promise((resolve) => {
            db.run('UPDATE users SET total_earned = total_earned + ?, completed_projects = completed_projects + 1 WHERE id = ?',
                [order.amount, order.seller_id], resolve);
        });

        const hash = crypto.randomBytes(16).toString('hex');
        db.run(`
            INSERT INTO transactions (user_id, transaction_hash, type, amount, status, description, related_entity_type, related_entity_id, created_at)
            VALUES (?, ?, 'earning', ?, 'completed', 'Оплата за завершенный заказ', 'order', ?, datetime('now'))
        `, [order.seller_id, hash, order.amount, order.id]);

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.post('/api/orders/:id/review', async (req, res) => {
    if (!requireRoleApi(req, res, ['client'])) return;

    const {rating, comment} = req.body;
    const order = await getOrderWithSeller(req.params.id);
    if (!order) return res.status(404).json({error: 'Заказ не найден'});
    if (order.buyer_id !== req.session.user.id) return res.status(403).json({error: 'Это не ваш заказ'});
    if (order.status !== 'completed') return res.status(400).json({error: 'Отзыв можно оставить только после завершения'});
    if (!rating || Number(rating) < 1 || Number(rating) > 5) return res.status(400).json({error: 'Оценка должна быть от 1 до 5'});

    const existing = await new Promise((resolve) => {
        db.get('SELECT id FROM reviews WHERE from_user_id = ? AND work_id = ?', [order.buyer_id, order.work_id], (err, row) => resolve(row));
    });
    if (existing) return res.status(400).json({error: 'Вы уже оставили отзыв по этому заказу'});

    try {
        await new Promise((resolve, reject) => {
            db.run(`
                INSERT INTO reviews (from_user_id, to_user_id, work_id, rating, comment, is_positive, created_at)
                VALUES (?, ?, ?, ?, ?, ?, datetime('now'))
            `, [order.buyer_id, order.seller_id, order.work_id, rating, comment || '', Number(rating) >= 4 ? 1 : 0],
                (err) => err ? reject(err) : resolve());
        });

        await new Promise((resolve) => {
            db.run(`
                UPDATE users
                SET rating = (
                    SELECT ROUND(AVG(rating), 2)
                    FROM reviews
                    WHERE to_user_id = ?
                )
                WHERE id = ?
            `, [order.seller_id, order.seller_id], resolve);
        });

        await new Promise((resolve) => {
            db.run(`
                UPDATE works
                SET rating = (
                    SELECT ROUND(AVG(rating), 2)
                    FROM reviews
                    WHERE work_id = ?
                ),
                reviews_count = (
                    SELECT COUNT(id)
                    FROM reviews
                    WHERE work_id = ?
                )
                WHERE id = ?
            `, [order.work_id, order.work_id, order.work_id], resolve);
        });

        res.json({success: true});
    } catch (err) {
        console.error(err);
        res.status(500).json({error: err.message});
    }
});

app.get('/api/my-orders', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const userId = req.session.user.id;

    const orders = await new Promise((resolve) => {
        db.all(`
            SELECT o.*,
                   w.title     as work_title,
                   w.seller_id,
                   u.full_name as seller_name,
                   wp.name     as package_name
            FROM orders o
                     JOIN works w ON o.work_id = w.id
                     JOIN users u ON w.seller_id = u.id
                     JOIN work_packages wp ON o.package_id = wp.id
            WHERE o.buyer_id = ?
            ORDER BY o.created_at DESC
        `, [userId], (err, rows) => {
            resolve(rows || []);
        });
    });

    res.json(orders);
});

// Страница моих заказов (покупки)
app.get('/my-orders', async (req, res) => {
    if (!requireRolePage(req, res, ['client'])) return;

    try {
        const userId = req.session.user.id;

        const orders = await new Promise((resolve) => {
            db.all(`
                SELECT o.*,
                       w.title     as work_title,
                       w.seller_id,
                       u.full_name as seller_name,
                       wp.name     as package_name,
                       wp.delivery_days,
                       r.id        as review_id
                FROM orders o
                         JOIN works w ON o.work_id = w.id
                         JOIN users u ON w.seller_id = u.id
                         JOIN work_packages wp ON o.package_id = wp.id
                         LEFT JOIN reviews r ON r.from_user_id = o.buyer_id AND r.work_id = o.work_id
                WHERE o.buyer_id = ?
                ORDER BY o.created_at DESC
            `, [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        res.render('my-orders', {orders, title: 'Мои покупки — Ворк.Тап'});
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

// Отправить сообщение
app.get('/seller/orders', async (req, res) => {
    if (!requireRolePage(req, res, ['freelancer'])) return;

    try {
        const userId = req.session.user.id;

        const orders = await new Promise((resolve) => {
            db.all(`
                SELECT o.*,
                       w.title     as work_title,
                       w.seller_id,
                       buyer.full_name as buyer_name,
                       buyer.id as buyer_id,
                       wp.name     as package_name,
                       wp.delivery_days
                FROM orders o
                         JOIN works w ON o.work_id = w.id
                         JOIN users buyer ON o.buyer_id = buyer.id
                         JOIN work_packages wp ON o.package_id = wp.id
                WHERE w.seller_id = ?
                ORDER BY o.created_at DESC
            `, [userId], (err, rows) => {
                resolve(rows || []);
            });
        });

        res.render('seller-orders', {orders, title: 'Заказы на мои ворки — Ворк.Тап'});
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.get('/admin', async (req, res) => {
    if (!requireAdminPage(req, res)) return;

    try {
        const stats = await new Promise((resolve) => {
            db.get(`
                SELECT
                    (SELECT COUNT(*) FROM users) as users_count,
                    (SELECT COUNT(*) FROM users WHERE is_active = 0) as blocked_users_count,
                    (SELECT COUNT(*) FROM works) as works_count,
                    (SELECT COUNT(*) FROM projects) as projects_count,
                    (SELECT COUNT(*) FROM orders) as orders_count,
                    (SELECT COUNT(*) FROM orders WHERE status = 'completed') as completed_orders_count,
                    (SELECT COALESCE(SUM(amount), 0) FROM orders WHERE status IN ('paid', 'in_progress', 'delivered', 'completed')) as order_volume,
                    (SELECT COUNT(*) FROM messages) as messages_count
            `, (err, row) => resolve(row || {}));
        });

        const users = await new Promise((resolve) => {
            db.all(`
                SELECT u.id, u.email, u.full_name, u.phone, u.role, u.rating, u.is_active, u.created_at,
                       COALESCE(w.balance, 0) as balance,
                       COALESCE(w.frozen_balance, 0) as frozen_balance
                FROM users u
                         LEFT JOIN wallets w ON w.user_id = u.id
                ORDER BY u.id DESC
                LIMIT 80
            `, (err, rows) => resolve(rows || []));
        });

        const orders = await new Promise((resolve) => {
            db.all(`
                SELECT o.id, o.amount, o.status, o.created_at,
                       w.title as work_title,
                       buyer.full_name as buyer_name,
                       seller.full_name as seller_name
                FROM orders o
                         JOIN works w ON w.id = o.work_id
                         JOIN users buyer ON buyer.id = o.buyer_id
                         JOIN users seller ON seller.id = w.seller_id
                ORDER BY o.id DESC
                LIMIT 60
            `, (err, rows) => resolve(rows || []));
        });

        const works = await new Promise((resolve) => {
            db.all(`
                SELECT w.id, w.title, w.is_active, w.rating, w.reviews_count, w.created_at,
                       u.full_name as seller_name,
                       c.name as category_name
                FROM works w
                         JOIN users u ON u.id = w.seller_id
                         JOIN categories c ON c.id = w.category_id
                ORDER BY w.id DESC
                LIMIT 60
            `, (err, rows) => resolve(rows || []));
        });

        const projects = await new Promise((resolve) => {
            db.all(`
                SELECT p.id, p.title, p.budget, p.status, p.created_at,
                       u.full_name as client_name,
                       c.name as category_name
                FROM projects p
                         JOIN users u ON u.id = p.client_id
                         JOIN categories c ON c.id = p.category_id
                ORDER BY p.id DESC
                LIMIT 60
            `, (err, rows) => resolve(rows || []));
        });

        const messages = await new Promise((resolve) => {
            db.all(`
                SELECT m.id, m.message, m.created_at,
                       sender.full_name as sender_name,
                       receiver.full_name as receiver_name,
                       COUNT(ma.id) as attachments_count
                FROM messages m
                         JOIN users sender ON sender.id = m.from_user_id
                         JOIN users receiver ON receiver.id = m.to_user_id
                         LEFT JOIN message_attachments ma ON ma.message_id = m.id
                GROUP BY m.id
                ORDER BY m.id DESC
                LIMIT 60
            `, (err, rows) => resolve(rows || []));
        });

        res.render('admin', {
            title: 'Админка — Ворк.Тап',
            currentPath: '/admin',
            stats,
            users,
            orders,
            works,
            projects,
            messages
        });
    } catch (err) {
        console.error(err);
        res.status(500).send('Ошибка сервера');
    }
});

app.post('/api/admin/users/:id/role', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    const {role} = req.body;
    const allowed = ['client', 'freelancer', 'both', 'admin'];
    if (!allowed.includes(role)) return res.status(400).json({error: 'Неверная роль'});
    db.run('UPDATE users SET role = ?, updated_at = datetime("now") WHERE id = ?', [role, req.params.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/admin/users/:id/toggle-active', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    if (Number(req.params.id) === req.session.user.id) {
        return res.status(400).json({error: 'Нельзя заблокировать самого себя'});
    }
    db.run('UPDATE users SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = datetime("now") WHERE id = ?', [req.params.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/admin/users/:id/balance', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    const amount = Number(req.body.amount);
    if (!Number.isFinite(amount)) return res.status(400).json({error: 'Неверная сумма'});
    db.run(`
        INSERT INTO wallets (user_id, balance, frozen_balance)
        VALUES (?, ?, 0)
        ON CONFLICT(user_id) DO UPDATE SET balance = balance + excluded.balance, updated_at = datetime('now')
    `, [req.params.id, amount], function (err) {
        if (err) return res.status(500).json({error: err.message});
        const hash = crypto.randomBytes(16).toString('hex');
        db.run(`
            INSERT INTO transactions (user_id, transaction_hash, type, amount, status, description, related_entity_type, related_entity_id, created_at)
            VALUES (?, ?, 'admin_adjustment', ?, 'completed', 'Корректировка баланса администратором', 'user', ?, datetime('now'))
        `, [req.params.id, hash, amount, req.params.id]);
        res.json({success: true});
    });
});

app.post('/api/admin/orders/:id/status', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    const {status} = req.body;
    const allowed = ['paid', 'in_progress', 'delivered', 'completed', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({error: 'Неверный статус'});
    db.run('UPDATE orders SET status = ?, updated_at = datetime("now") WHERE id = ?', [status, req.params.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/admin/works/:id/toggle-active', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    db.run('UPDATE works SET is_active = CASE WHEN is_active = 1 THEN 0 ELSE 1 END, updated_at = datetime("now") WHERE id = ?', [req.params.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/admin/projects/:id/status', (req, res) => {
    if (!requireAdminApi(req, res)) return;
    const {status} = req.body;
    const allowed = ['open', 'in_progress', 'completed', 'cancelled'];
    if (!allowed.includes(status)) return res.status(400).json({error: 'Неверный статус'});
    db.run('UPDATE projects SET status = ?, updated_at = datetime("now") WHERE id = ?', [status, req.params.id], function (err) {
        if (err) return res.status(500).json({error: err.message});
        res.json({success: true});
    });
});

app.post('/api/messages', async (req, res) => {
    if (!req.session.user) {
        return res.status(401).json({error: 'Требуется авторизация'});
    }

    const {to_user_id, message, attachments} = req.body;
    const from_user_id = req.session.user.id;
    const text = String(message || '').trim();
    const files = Array.isArray(attachments) ? attachments.slice(0, 5) : [];

    if (!to_user_id || Number(to_user_id) === from_user_id) {
        return res.status(400).json({error: 'Неверный получатель'});
    }

    if (!text && files.length === 0) {
        return res.status(400).json({error: 'Введите сообщение или прикрепите фото'});
    }

    if (files.length > 5) {
        return res.status(400).json({error: 'Можно отправить до 5 фото за раз'});
    }

    const targetUser = await new Promise((resolve) => {
        db.get('SELECT id FROM users WHERE id = ? AND is_active = 1', [to_user_id], (err, row) => resolve(row));
    });
    if (!targetUser) {
        return res.status(404).json({error: 'Получатель не найден'});
    }

    db.run(`
        INSERT INTO messages (from_user_id, to_user_id, message, created_at)
        VALUES (?, ?, ?, datetime('now'))
    `, [from_user_id, to_user_id, text], async function (err) {
        if (err) return res.status(500).json({error: err.message});

        try {
            await saveChatAttachments(this.lastID, files);
            res.json({success: true, messageId: this.lastID});
        } catch (uploadErr) {
            db.run('DELETE FROM messages WHERE id = ?', [this.lastID]);
            res.status(400).json({error: uploadErr.message});
        }
    });
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 Сервер запущен на http://localhost:${PORT}`);
    console.log(`📁 База данных: ${dbPath}`);
    console.log(`📁 Шаблоны: views/`);
    console.log(`📁 Статика: public/`);
});

process.on('SIGINT', () => {
    db.close((err) => {
        if (err) {
            console.error(err.message);
        }
        console.log('👋 База данных закрыта');
        process.exit(0);
    });
});
