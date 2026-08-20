// Shared "uploaded documents" widget: upload form + list + extracted-data view.
// Mounted onto any element with class="documents-section" found on the page
// (patient1.html, P1report.html, report1.65.html). The target patient is either
// this section's data-patient-id attribute or a ?patientId= URL param (doctor
// pages); with neither, the API falls back to the logged-in user (auth.sub).
(function () {
  // Must match MAX_FILE_BYTES in api/documents/[...slug].js — kept here too so we
  // can reject an oversized file before ever sending it over the network.
  const MAX_UPLOAD_BYTES = 2.5 * 1024 * 1024;

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

  // Extracted data has no fixed shape (it varies per document type — see
  // api/_claude.js's extraction prompt), so unlike the fixed 27 feedback fields
  // this can't be hand-authored per-field spans. Instead it's rendered generically
  // into the same "Label: value" paragraph style used everywhere else in the
  // report1.*.html pages (see report1.html's <p><strong>...</strong> <span>...`
  // rows), so it reads like part of the report rather than a JSON dump.
  function humanizeKey(key) {
    return String(key)
      .replace(/_/g, ' ')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function isPlainObject(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
  }

  // Renders a scalar or array value as inline HTML; returns null for anything
  // empty (so the caller can skip the whole row rather than show a blank line).
  function renderInlineValue(value) {
    if (value === null || value === undefined || value === '') return null;
    if (Array.isArray(value)) {
      const items = value
        .map((item) => {
          if (isPlainObject(item)) {
            const parts = Object.entries(item)
              .map(([k, v]) => {
                const rendered = renderInlineValue(v);
                return rendered ? `${humanizeKey(k)}: ${rendered}` : null;
              })
              .filter(Boolean);
            return parts.length ? parts.join(', ') : null;
          }
          return escapeHtml(String(item));
        })
        .filter(Boolean);
      if (items.length === 0) return null;
      return `<ul style="margin:4px 0 4px 1.1rem; padding:0;">${items.map((i) => `<li>${i}</li>`).join('')}</ul>`;
    }
    if (isPlainObject(value)) return null; // objects are rendered as their own subsection below
    return escapeHtml(String(value));
  }

  function renderExtractedInfo(extractedJson) {
    if (!extractedJson || typeof extractedJson !== 'object') {
      return '<p style="color:#9ca3af; font-size:13px; margin-left:0;">No extracted information.</p>';
    }

    const topLevelRows = [];
    const subsections = [];

    Object.entries(extractedJson).forEach(([key, value]) => {
      if (isPlainObject(value)) {
        const rows = Object.entries(value)
          .map(([k, v]) => {
            const rendered = renderInlineValue(v);
            return rendered ? `<p style="margin:2px 0 2px 0;"><strong>${humanizeKey(k)}:</strong> ${rendered}</p>` : null;
          })
          .filter(Boolean);
        if (rows.length) {
          subsections.push(
            `<div style="margin-top:10px;">` +
              `<div style="color:chocolate; font-weight:600; font-size:13px; margin-bottom:2px;">${humanizeKey(key)}</div>` +
              rows.join('') +
            `</div>`
          );
        }
      } else {
        const rendered = renderInlineValue(value);
        if (rendered) {
          topLevelRows.push(`<p style="margin:2px 0;"><strong>${humanizeKey(key)}:</strong> ${rendered}</p>`);
        }
      }
    });

    if (topLevelRows.length === 0 && subsections.length === 0) {
      return '<p style="color:#9ca3af; font-size:13px; margin-left:0;">No extracted information.</p>';
    }

    return `<div style="font-size:14px; line-height:1.6; margin-top:10px;">${topLevelRows.join('')}${subsections.join('')}</div>`;
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
        ${doc.extracted_json ? renderExtractedInfo(doc.extracted_json) : ''}
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

        // Vercel rejects any request body over ~4.5MB at the platform level, before
        // it ever reaches our function — base64 adds ~33% overhead, so a raw file
        // over MAX_UPLOAD_BYTES would blow that ceiling and fail with a raw
        // (non-JSON) "payload too large" error. Catch it here instead, with a
        // message the patient/doctor can actually act on.
        if (file.size > MAX_UPLOAD_BYTES) {
          if (statusEl) {
            statusEl.textContent = `File too large (${formatBytes(file.size)}). Max size is ${formatBytes(MAX_UPLOAD_BYTES)}.`;
            statusEl.style.color = '#dc2626';
          }
          return;
        }

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

          // A platform-level rejection (payload too large, gateway timeout, etc.)
          // returns HTML/plain text, not JSON — parsing that as JSON is what throws
          // the confusing "unexpected character" error, so check first.
          let data;
          const contentType = resp.headers.get('content-type') || '';
          if (contentType.includes('application/json')) {
            data = await resp.json();
          } else {
            throw new Error(
              resp.status === 413
                ? 'File too large for the server to accept.'
                : `Upload failed (server returned ${resp.status}).`
            );
          }
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
