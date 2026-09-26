import { supabase } from '../lib/supabase.js';
import { $, setLoading } from '../lib/ui.js';

const ERRORS = {
  'User already registered': 'هذا البريد مسجّل مسبقاً — جرّب تسجيل الدخول.',
  'Password should be at least 8 characters.': 'كلمة السر لازم تكون ٨ أحرف على الأقل.',
};

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim();
  const password = $('#password').value;
  const btn = e.submitter;
  $('#error').textContent = '';

  if (!/^\S+@\S+\.\S+$/.test(email)) return ($('#error').textContent = 'البريد الإلكتروني غير صحيح.');
  if (password.length < 8) return ($('#error').textContent = 'كلمة السر لازم تكون ٨ أحرف على الأقل.');

  setLoading(btn, true);
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { emailRedirectTo: `${location.origin}/dashboard.html` },
  });
  setLoading(btn, false);

  if (error) return ($('#error').textContent = ERRORS[error.message] || error.message);

  if (data.session) {
    location.href = '/dashboard.html';        // email confirmation disabled
  } else {
    $('#form').classList.add('hidden');       // email confirmation required
    $('#sent').classList.remove('hidden');
  }
});
