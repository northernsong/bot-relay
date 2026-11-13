export function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

export const adminCss = `
:root { color-scheme: light; font-family: "Iowan Old Style", Palatino, Georgia, serif; }
body { margin: 0; background: #f4f1ea; color: #1c1915; }
header, main { max-width: 960px; margin: 0 auto; padding: 24px; }
h1 { font-size: 1.6rem; margin: 0 0 8px; }
p, li { line-height: 1.45; }
table { width: 100%; border-collapse: collapse; background: #fffdf8; }
th, td { text-align: left; padding: 8px 10px; border-bottom: 1px solid #e4dccb; font-size: 0.95rem; vertical-align: top; }
button, input, select { font: inherit; }
button { background: #1c1915; color: #f4f1ea; border: 0; padding: 6px 10px; cursor: pointer; }
button.ghost { background: transparent; color: #1c1915; border: 1px solid #1c1915; }
form.login, form.invite { display: grid; gap: 10px; max-width: 420px; }
label { display: grid; gap: 4px; font-size: 0.9rem; }
input { padding: 8px; border: 1px solid #c9bfae; background: white; }
.note { color: #5c5348; }
code { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
`;

export function loginPage(): string {
  return layout('Admin login', `
    <h1>bot-relay admin</h1>
    <p class="note">Sign in with the deployment admin token. It is stored only in an HttpOnly cookie.</p>
    <form class="login" method="post" action="/admin/login">
      <label>Admin token <input type="password" name="token" autocomplete="current-password" required></label>
      <button type="submit">Sign in</button>
    </form>
  `);
}

export function dashboardPage(csrf: string): string {
  return layout('Admin', `
    <header class="row">
      <h1>bot-relay admin</h1>
      <form method="post" action="/admin/logout"><input type="hidden" name="csrf" value="${escapeHtml(csrf)}"><button class="ghost" type="submit">Sign out</button></form>
    </header>
    <main>
      <section>
        <h2>Bots</h2>
        <p class="note">Webhook URLs, relay tokens, and stored credentials are not shown.</p>
        <table id="bots"><thead><tr><th>Id</th><th>Name</th><th>Delivery</th><th>Status</th><th>Messages</th><th>Deliveries</th><th></th></tr></thead><tbody></tbody></table>
      </section>
      <section>
        <h2>Invite codes</h2>
        <form class="invite" id="invite-form">
          <label>Label <input name="label" maxlength="80" placeholder="optional"></label>
          <label>Uses <input name="max_uses" type="number" min="1" max="1000" value="1"></label>
          <label>Expires in seconds <input name="ttl_sec" type="number" min="0" placeholder="blank = never"></label>
          <button type="submit">Create invite</button>
        </form>
        <p id="new-invite" class="note"></p>
        <table id="invites"><thead><tr><th>Prefix</th><th>Uses</th><th>Expires</th><th>Status</th><th></th></tr></thead><tbody></tbody></table>
      </section>
    </main>
    <script src="/admin/app.js"></script>
  `, csrf);
}

export function registerPage(code: string): string {
  return layout('Register a bot', `
    <h1>Register a bot</h1>
    <p class="note">You need an invite code. The relay token is shown once.</p>
    <form class="login" id="register-form">
      <label>Invite code <input name="invite_code" required value="${escapeHtml(code)}"></label>
      <label>Bot id <input name="id" required pattern="[a-z0-9][a-z0-9_-]{1,31}" placeholder="alice"></label>
      <label>Display name <input name="display_name" required maxlength="80"></label>
      <label>Webhook URL <input name="webhook_url" placeholder="optional https URL"></label>
      <label>Auth header name <input name="auth_header_name" placeholder="Authorization"></label>
      <label>Auth header value <input name="auth_header_value" placeholder="Bearer ..."></label>
      <button type="submit">Register</button>
    </form>
    <pre id="result" class="note"></pre>
    <script src="/register/app.js"></script>
  `);
}

export const adminJs = `
const csrf = document.querySelector('meta[name="csrf"]').content;
const headers = { 'content-type': 'application/json', 'x-csrf-token': csrf };
async function api(path, opts = {}) {
  const res = await fetch(path, { ...opts, headers: { ...headers, ...(opts.headers || {}) } });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error && data.error.message || res.statusText);
  return data;
}
function cell(text) { const td = document.createElement('td'); td.textContent = text == null ? '' : String(text); return td; }
async function loadBots() {
  const body = document.querySelector('#bots tbody');
  body.replaceChildren();
  const data = await api('/admin/api/bots');
  for (const bot of data.bots) {
    const tr = document.createElement('tr');
    tr.append(cell(bot.id), cell(bot.display_name), cell(bot.delivery), cell(bot.disabled ? 'disabled' : 'active'), cell(bot.message_count), cell(bot.delivery_count));
    const actions = document.createElement('td');
    const toggle = document.createElement('button');
    toggle.textContent = bot.disabled ? 'Enable' : 'Disable';
    toggle.onclick = async () => { await api('/admin/api/bots/' + encodeURIComponent(bot.id) + (bot.disabled ? '/enable' : '/disable'), { method: 'POST' }); await loadBots(); };
    const del = document.createElement('button');
    del.className = 'ghost';
    del.textContent = 'Delete';
    del.onclick = async () => { if (!confirm('Delete ' + bot.id + '?')) return; await api('/admin/api/bots/' + encodeURIComponent(bot.id), { method: 'DELETE' }); await loadBots(); };
    actions.append(toggle, document.createTextNode(' '), del);
    tr.append(actions);
    body.append(tr);
  }
}
async function loadInvites() {
  const body = document.querySelector('#invites tbody');
  body.replaceChildren();
  const data = await api('/admin/api/invites');
  for (const invite of data.invites) {
    const tr = document.createElement('tr');
    tr.append(cell(invite.prefix), cell(invite.uses + ' / ' + invite.max_uses), cell(invite.expires_at || 'never'), cell(invite.revoked ? 'revoked' : 'active'));
    const actions = document.createElement('td');
    if (!invite.revoked) {
      const revoke = document.createElement('button');
      revoke.className = 'ghost';
      revoke.textContent = 'Revoke';
      revoke.onclick = async () => { await api('/admin/api/invites/' + invite.id + '/revoke', { method: 'POST' }); await loadInvites(); };
      actions.append(revoke);
    }
    tr.append(actions);
    body.append(tr);
  }
}
document.querySelector('#invite-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const ttl = form.get('ttl_sec');
  const payload = { label: form.get('label') || null, max_uses: Number(form.get('max_uses') || 1) };
  if (ttl !== '') payload.ttl_sec = Number(ttl);
  const created = await api('/admin/api/invites', { method: 'POST', body: JSON.stringify(payload) });
  const box = document.querySelector('#new-invite');
  box.textContent = '';
  const code = document.createElement('code');
  code.textContent = created.invite.code + ' ';
  const link = document.createElement('a');
  link.href = created.invite.register_url;
  link.textContent = created.invite.register_url;
  const copy = document.createElement('button');
  copy.type = 'button';
  copy.textContent = 'Copy link';
  copy.onclick = () => navigator.clipboard.writeText(created.invite.register_url);
  box.append('New invite: ', code, link, ' ', copy);
  await loadInvites();
};
loadBots().catch((err) => alert(err.message));
loadInvites().catch((err) => alert(err.message));
`;

export const registerJs = `
document.querySelector('#register-form').onsubmit = async (event) => {
  event.preventDefault();
  const form = new FormData(event.target);
  const payload = Object.fromEntries(form.entries());
  for (const key of Object.keys(payload)) if (payload[key] === '') delete payload[key];
  const res = await fetch('/register', { method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json' }, body: JSON.stringify(payload) });
  const data = await res.json().catch(() => ({}));
  const box = document.querySelector('#result');
  if (!res.ok) { box.textContent = (data.error && data.error.message) || 'Registration failed'; return; }
  box.textContent = 'Copy these now. They will not be shown again.\\nrelay token: ' + data.token + '\\na2a token: ' + (data.a2a_token || '');
};
`;

function layout(title: string, body: string, csrf?: string): string {
  const meta = csrf ? `<meta name="csrf" content="${escapeHtml(csrf)}">` : '';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)}</title>${meta}<link rel="stylesheet" href="/admin/app.css"></head><body>${body}</body></html>`;
}
