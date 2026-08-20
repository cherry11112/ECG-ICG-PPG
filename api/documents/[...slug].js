// /api/documents/[...slug].js
// Routes:
//   POST /api/documents            - upload a document, store original in R2, extract via Claude
//   GET  /api/documents            - list a patient's documents (?patientId= for doctors)
//   GET  /api/documents/:id/file   - presigned URL to download the original file

import { randomUUID } from 'crypto';
import {
  ensureSchema,
  insertPatientDocument,
  markPatientDocumentDone,
  markPatientDocumentFailed,
  getPatientDocuments,
  getPatientDocumentById,
} from '../_db.js';
import { requireAuth } from '../_auth.js';
import { putObject, getPresignedGetUrl } from '../_r2.js';
import { extractDocumentData } from '../_claude.js';

export const config = {
  maxDuration: 60, // extraction call to Claude needs more than the ~10s default
};

const ACCEPTED_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf', 'text/plain',
]);
// Vercel enforces a hard ~4.5MB request body ceiling that cannot be configured away.
// Base64 adds ~33% overhead, so cap the raw file well under that so the encoded
// JSON payload (file + a little envelope) still fits.
const MAX_FILE_BYTES = 2.5 * 1024 * 1024; // 2.5MB raw ≈ ~3.3MB base64

function resolvePatientId(auth, requestedPatientId) {
  if (requestedPatientId && auth.role === 'doctor') {
    return Number(requestedPatientId);
  }
  return auth.sub;
}

function extFromContentType(contentType) {
  const map = {
    'image/jpeg': 'jpg', 'image/png': 'png', 'image/gif': 'gif',
    'image/webp': 'webp', 'application/pdf': 'pdf', 'text/plain': 'txt',
  };
  return map[contentType] || 'bin';
}

export default async function handler(req, res) {
  await ensureSchema();

  const auth = requireAuth(req);
  if (!auth) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const slug = req.query.slug;
  const parts = Array.isArray(slug) ? slug : (slug ? [slug] : []);

  // GET /api/documents/:id/file
  if (parts.length === 2 && parts[1] === 'file' && req.method === 'GET') {
    try {
      const documentId = parseInt(parts[0], 10);
      const doc = await getPatientDocumentById(documentId);
      if (!doc) {
        return res.status(404).json({ error: 'Document not found' });
      }
      if (auth.role !== 'doctor' && doc.patient_id !== auth.sub) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      const url = await getPresignedGetUrl(doc.r2_original_key, 300);
      return res.status(200).json({ url, filename: doc.original_filename });
    } catch (err) {
      console.error('[documents/:id/file]', err);
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }

  // GET /api/documents?patientId=
  if (parts.length === 0 && req.method === 'GET') {
    try {
      const patientId = resolvePatientId(auth, req.query.patientId);
      const documents = await getPatientDocuments(patientId);
      return res.status(200).json({ documents });
    } catch (err) {
      console.error('[GET /api/documents]', err);
      return res.status(500).json({ error: 'Internal Server Error' });
    }
  }

  // POST /api/documents
  if (parts.length === 0 && req.method === 'POST') {
    try {
      const { patientId: requestedPatientId, filename, contentType, data_base64 } = req.body || {};

      if (!filename || !contentType || !data_base64) {
        return res.status(400).json({
          error: 'Missing required fields',
          required: ['filename', 'contentType', 'data_base64'],
        });
      }

      if (!ACCEPTED_TYPES.has(contentType)) {
        return res.status(400).json({
          error: `Unsupported file type: "${contentType}"`,
          accepted: Array.from(ACCEPTED_TYPES),
        });
      }

      const fileBuffer = Buffer.from(data_base64, 'base64');
      if (fileBuffer.length > MAX_FILE_BYTES) {
        return res.status(400).json({
          error: `File too large: ${fileBuffer.length} bytes (max ${MAX_FILE_BYTES})`,
        });
      }

      const patientId = resolvePatientId(auth, requestedPatientId);
      const documentId = randomUUID();
      const r2OriginalKey = `patients/${patientId}/documents/${documentId}/original.${extFromContentType(contentType)}`;

      const dbRow = await insertPatientDocument(patientId, auth.sub, {
        originalFilename: filename,
        contentType,
        fileSizeBytes: fileBuffer.length,
        r2OriginalKey,
      });

      await putObject(r2OriginalKey, fileBuffer, contentType);

      try {
        const { extracted, model } = await extractDocumentData({
          mediaType: contentType,
          base64Data: data_base64,
          filename,
        });

        const r2JsonKey = `patients/${patientId}/documents/${documentId}/extracted.json`;
        await putObject(r2JsonKey, JSON.stringify(extracted, null, 2), 'application/json');

        const updated = await markPatientDocumentDone(dbRow.id, {
          r2JsonKey,
          documentType: extracted.document_type || null,
          extractedJson: extracted,
          extractionModel: model,
        });

        return res.status(200).json({ success: true, document: updated });
      } catch (extractionErr) {
        // The original file is already safely stored — only extraction failed.
        // Never write fabricated JSON here; just record the failure.
        console.error('[documents] extraction failed:', extractionErr);
        const updated = await markPatientDocumentFailed(dbRow.id, extractionErr.message);
        return res.status(200).json({ success: true, document: updated });
      }
    } catch (err) {
      console.error('[POST /api/documents]', err);
      return res.status(500).json({ error: err.message || 'Internal Server Error' });
    }
  }

  return res.status(404).json({ error: 'Endpoint not found' });
}
