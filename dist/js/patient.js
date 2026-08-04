document.addEventListener('DOMContentLoaded', () => {
  const form = document.getElementById('feedbackForm');
  if (!form) return;
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = localStorage.getItem('token');
    if (!token) { window.location.href = 'index.html'; return; }
    const formData = new FormData(form);
    const payload = {};
    formData.forEach((v, k) => { payload[k] = v; });
    try {
      const res = await fetch('/api/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json().catch(() => ({}));
      
      console.log('[patient.js] Response status:', res.status, 'data:', data);
      
      if (!res.ok) {
        // Check for daily submission conflict
        if (res.status === 400 && data.error && data.error.includes('already submitted')) {
          alert('You have already submitted your daily feedback today. Please try again tomorrow.');
          // Disable form if it's the daily limit error
          form.querySelectorAll('input, select, textarea').forEach(el => {
            el.disabled = true;
          });
          const submitBtn = document.getElementById('submitBtn');
          if (submitBtn) {
            submitBtn.disabled = true;
            submitBtn.textContent = 'Already submitted today';
          }
        } else {
          // Show detailed error for debugging
          const errorMsg = data.error || 'Submit failed';
          const detailedMsg = data.details ? `${errorMsg}\n(Details: ${data.details})` : errorMsg;
          alert('Error: ' + detailedMsg);
          console.error('[patient.js] Submission error:', data);
        }
        return;
      }
      alert('Feedback submitted successfully');
      form.reset();
      // Disable form after successful submission
      form.querySelectorAll('input, select, textarea').forEach(el => {
        el.disabled = true;
      });
      const submitBtn = document.getElementById('submitBtn');
      if (submitBtn) {
        submitBtn.disabled = true;
        submitBtn.textContent = 'Already submitted today';
      }
    } catch (err) {
      console.error('[patient.js] Network error:', err);
      alert('Network error: ' + err.message);
    }
  });
});



