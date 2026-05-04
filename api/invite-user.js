import { createClient } from '@supabase/supabase-js';

const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { autoRefreshToken: false, persistSession: false } }
);

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return res.status(401).json({ error: 'Token ausente' });

  const { data: { user }, error: authErr } = await supabaseAdmin.auth.getUser(token);
  if (authErr || !user) return res.status(401).json({ error: 'Token inválido' });

  const { data: profile, error: profErr } = await supabaseAdmin
    .from('profiles').select('is_admin').eq('id', user.id).single();
  if (profErr) return res.status(500).json({ error: 'Erro ao verificar perfil', detail: profErr.message });
  if (!profile?.is_admin) return res.status(403).json({ error: 'Não é admin' });

  const { email } = req.body || {};
  if (!email) return res.status(400).json({ error: 'E-mail obrigatório' });

  // Convidar usuário
  const { data, error } = await supabaseAdmin.auth.admin.inviteUserByEmail(email);
  if (error) return res.status(400).json({ error: error.message });

  // Tentar criar perfil — erro aqui não deve quebrar o retorno
  // (o perfil pode ser criado depois quando o usuário ativar a conta)
  try {
    await supabaseAdmin
      .from('profiles')
      .upsert({ id: data.user.id, is_admin: false }, { onConflict: 'id', ignoreDuplicates: true });
  } catch (e) {
    console.warn('Perfil não criado agora, será criado no primeiro login:', e.message);
  }

  // Retorna sucesso independente do perfil
  return res.status(200).json({ success: true, email: data.user.email });
}