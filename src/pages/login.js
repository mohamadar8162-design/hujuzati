import { supabase } from '../lib/supabase.js';
import { $, setLoading, toast } from '../lib/ui.js';

const { data } = await supabase.auth.getSession();
if (data.session) location.href = '/dashboard.html';

$('#form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = e.submitter;
  $('#error').textContent = '';
  setLoading(btn, true);
  const { error } = await supabase.auth.signInWithPassword({
    email: $('#email').value.trim(),
    password: $('#password').value,
  });
  setLoading(btn, false);
  if (error) {
    $('#error').textContent =
      error.message === 'Invalid login credentials' ? 'البريد أو كلمة السر غير صحيحة.'
      : error.message === 'Email not confirmed' ? 'لازم تأكد بريدك أول — تفقّد صندوق الوارد.'
      : error.message;
    return;
  }
  location.href = '/dashboard.html';
});

$('#forgot').addEventListener('click', async (e) => {
  e.preventDefault();
  const email = $('#email').value.trim();
  if (!email) return ($('#error').textContent = 'اكتب بريدك أولاً وبعدين اضغط "نسيت كلمة السر".');
  const { error } = await supabase.auth.resetPasswordForEmail(email, {
    redirectTo: `${location.origin}/dashboard.html`,
  });
  if (error) return toast(error.message, 'err');
  toast('بعتنالك رابط لتغيير كلمة السر ✉️');
});
