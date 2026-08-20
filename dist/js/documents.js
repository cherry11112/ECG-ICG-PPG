// Shared "uploaded documents" widget: upload form + list + extracted-data view.
// Mounted onto any element with class="documents-section" found on the page
// (patient1.html, P1report.html, report1.65.html). The target patient is either
// this section's data-patient-id attribute or a ?patientId= URL param (doctor
// pages); with neither, the API falls back to the logged-in user (auth.sub).
(function () {
  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    }[c]));
  }

  function formatBytes(bytes) {
    if (bytes === null || bytes === undefined) return '';
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  }

  function statusBadge(status) {
    const colors = {
      pending: '#9ca3af', processing: '#d97706', done: '#16a34a', failed: '#dc2626',
    };
    const color = colors[status] || '#6b7280';
    return `<span style="background:${color}22; color:${color}; padding:2px 10px; border-radius:999px; font-size:12px; font-weight:600;">${escapeHtml(status)}</span>`;
  }

  function fileToBase64(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(String(reader.result).split(',')[1] || '');
      reader.onerror = () => reject(new Error('Could not read file'));
      reader.readAsDataURL(file);
    });
  }

  function resolvePatientId(section) {
    return section.dataset.patientId
      || new URLSearchParams(window.location.search).get('patientId')
      || null;
  }

  async function fetchDocuments(patientId) {
    const token = localStorage.getItem('token');
    const qs = patientId ? `?patientId=${encodeURIComponent(patientId)}` : '';
    const resp = await fetch(`/api/documents${qs}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!resp.ok) throw new Error('Failed to load documents');
    const data = await resp.json();
    return data.documents || [];
  }

  async function viewOriginal(id) {
    const token = localStorage.getItem('token');
    try {
      const resp = await fetch(`/api/documents/${id}/file`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || 'Could not load file');
      window.open(data.url, '_blank', 'noopener');
    } catch (err) {
      alert(err.message);
    }
  }

  function renderExtractedJson(doc) {
    if (!doc.extracted_json) return '';
    return `<pre style="white-space:pre-wrap; word-break:break-word; font-size:12px; background:#f9fafb; border-radius:6px; padding:10px; margin-top:10px; max-height:240px; overflow:auto;">${escapeHtml(JSON.stringify(doc.extracted_json, null, 2))}</pre>`;
  }

  function renderDocumentCard(doc) {
    const failed = doc.extraction_status === 'failed';
    return `
      <div class="border border-gray-100 rounded-md p-4 mb-3">
        <div class="flex items-center justify-between" style="display:flex; align-items:center; justify-content:space-between; gap:8px;">
          <div>
            <div class="font-medium">${escapeHtml(doc.original_filename || 'Untitled document')}</div>
            <div class="text-xs text-gray-400" style="color:#9ca3af;">
              ${doc.document_type ? escapeHtml(doc.document_type) + ' · ' : ''}${new Date(doc.created_at).toLocaleString()} · ${formatBytes(doc.file_size_bytes)}
            </div>
          </div>
          <div style="display:flex; align-items:center; gap:10px; white-space:nowrap;">
            ${statusBadge(doc.extraction_status)}
            <button type="button" class="text-xs text-blue-600 view-original-btn" data-doc-id="${doc.id}" style="color:#2563eb; background:none; border:none; cursor:pointer; font-size:12px;">View original</button>
          </div>
        </div>
        ${failed ? `<div style="color:#dc2626; font-size:12px; margin-top:8px;">Extraction failed: ${escapeHtml(doc.extraction_error || 'unknown error')}</div>` : ''}
        ${renderExtractedJson(doc)}
      </div>
    `;
  }

  async function renderList(listEl, patientId) {
    listEl.innerHTML = '<p style="color:#9ca3af; font-size:14px;">Loading documents…</p>';
    try {
      const documents = await fetchDocuments(patientId);
      if (documents.length === 0) {
        listEl.innerHTML = '<p style="color:#9ca3af; font-size:14px;">No documents uploaded yet.</p>';
        return;
      }
      listEl.innerHTML = documents.map(renderDocumentCard).join('');
      listEl.querySelectorAll('.view-original-btn').forEach((btn) => {
        btn.addEventListener('click', () => viewOriginal(btn.dataset.docId));
      });
    } catch (err) {
      listEl.innerHTML = `<p style="color:#dc2626; font-size:14px;">${escapeHtml(err.message)}</p>`;
    }
  }

  function mount(section) {
    const patientId = resolvePatientId(section);
    const form = section.querySelector('.document-upload-form');
    const fileInput = section.querySelector('.document-file-input');
    const statusEl = section.querySelector('.document-upload-status');
    const listEl = section.querySelector('.documents-list');

    if (listEl) renderList(listEl, patientId);

    if (form) {
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const file = fileInput && fileInput.files[0];
        if (!file) return;

        const submitBtn = form.querySelector('button[type="submit"]');
        if (submitBtn) submitBtn.disabled = true;
        if (statusEl) {
          statusEl.textContent = 'Uploading and processing…';
          statusEl.style.color = '#6b7280';
        }

        try {
          const base64 = await fileToBase64(file);
          const token = localStorage.getItem('token');
          const body = { filename: file.name, contentType: file.type, data_base64: base64 };
          if (patientId) body.patientId = patientId;

          const resp = await fetch('/api/documents', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
            body: JSON.stringify(body),
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || 'Upload failed');

          const docFailed = data.document && data.document.extraction_status === 'failed';
          if (statusEl) {
            statusEl.textContent = docFailed
              ? `Uploaded, but processing failed: ${data.document.extraction_error || ''}`
              : 'Uploaded and processed successfully.';
            statusEl.style.color = docFailed ? '#dc2626' : '#16a34a';
          }
          form.reset();
          if (listEl) renderList(listEl, patientId);
        } catch (err) {
          if (statusEl) {
            statusEl.textContent = err.message;
            statusEl.style.color = '#dc2626';
          }
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      });
    }
  }

  document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.documents-section').forEach(mount);
  });
})();
