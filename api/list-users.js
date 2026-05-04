import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export default async function handler(req, res) {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  // 1. Pegar token do header
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token ausente' });

  // 2. Verificar usuário pelo token
  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) {
    return res.status(401).json({ error: 'Token inválido', detail: authErr?.message });
  }

  // 3. Verificar is_admin no profiles usando service role (ignora RLS)
  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles')
    .select('is_admin')
    .eq('id', user.id)
    .single();

  if (profErr) {
    return res.status(500).json({ error: 'Erro ao buscar perfil', detail: profErr.message });
  }

  if (!profile?.is_admin) {
    return res.status(403).json({ 
      error: 'Não é admin',
      userId: user.id,
      profile: profile 
    });
  }

  // 4. Listar todos os usuários
  const { data: { users }, error: listErr } = await supabaseAdmin.auth.admin.listUsers();
  if (listErr) return res.status(500).json({ error: listErr.message });

  // 5. Buscar perfis
  const { data: profiles } = await supabaseAdmin
    .from('profiles')
    .select('id, is_admin');

  const profileMap = {};
  (profiles || []).forEach(p => { profileMap[p.id] = p; });

  const result = users.map(u => ({
    id: u.id,
    email: u.email,
    created_at: u.created_at,
    last_sign_in_at: u.last_sign_in_at,
    email_confirmed_at: u.email_confirmed_at,
    banned: u.banned_until ? new Date(u.banned_until) > new Date() : false,
    is_admin: profileMap[u.id]?.is_admin || false,
  }));

  return res.status(200).json({ users: result });
}