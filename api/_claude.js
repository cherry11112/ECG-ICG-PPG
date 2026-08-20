// Shared helper for calling Claude to extract structured data from an uploaded
// document (image or PDF). Reuses the same raw-fetch + CLAUDE_API_KEY pattern
// already used in api/diagnostic/[...slug].js (generateClaudeDiagnostic) rather
// than introducing a new SDK dependency or a second way of talking to Claude.
const CLAUDE_API_KEY = process.env.CLAUDE_API_KEY;
const CLAUDE_API_URL = 'https://api.anthropic.com/v1/messages';
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

const EXTRACTION_SYSTEM_PROMPT = `You are a medical document extraction assistant. You will be shown a \
document (an image or PDF) that a patient or doctor uploaded to a cardiac remote-monitoring platform. \
Extract only the information that is actually present and legible in the document into a structured \
JSON object. Do not guess, fabricate, or infer any value that is not directly supported by the \
document's content — if something is missing, illegible, or not applicable, omit that field or set it \
to null rather than filling it in. Do not add clinical interpretation or diagnosis of your own.

Respond with ONLY a JSON object (no markdown fences, no commentary), using this shape as a flexible \
guide — add, omit, or nest fields as the document's actual content calls for, since not every document \
will have the same structure:

{
  "document_type": "medical_report | lab_result | prescription | discharge_summary | doctor_note | imaging_report | other",
  "patient_information": { "name": null, "date_of_birth": null },
  "medical_information": { "diagnoses": [], "medications": [], "medical_history": [] },
  "test_results": [],
  "measurements": {},
  "additional_information": null
}`;

function extractJsonFromText(text) {
  try {
    return JSON.parse(text);
  } catch {
    const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
    if (fenced) return JSON.parse(fenced[1]);
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start !== -1 && end !== -1) return JSON.parse(text.substring(start, end + 1));
    throw new Error('Could not parse JSON from Claude response');
  }
}

// mediaType: the upload's content type. base64Data: raw base64 (no data: prefix).
export async function extractDocumentData({ mediaType, base64Data, filename }) {
  if (!CLAUDE_API_KEY) {
    throw new Error('CLAUDE_API_KEY not configured');
  }

  let contentBlocks;
  if (mediaType === 'application/pdf') {
    contentBlocks = [
      { type: 'document', source: { type: 'base64', media_type: mediaType, data: base64Data } },
      { type: 'text', text: `Extract the information from this uploaded document (${filename || 'document.pdf'}).` },
    ];
  } else if (mediaType === 'text/plain') {
    const text = Buffer.from(base64Data, 'base64').toString('utf-8');
    contentBlocks = [
      { type: 'text', text: `Extract the information from this uploaded document (${filename || 'document.txt'}):\n\n${text}` },
    ];
  } else {
    contentBlocks = [
      { type: 'image', source: { type: 'base64', media_type: mediaType, data: base64Data } },
      { type: 'text', text: `Extract the information from this uploaded document (${filename || 'document'}).` },
    ];
  }

  const response = await fetch(CLAUDE_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': CLAUDE_API_KEY,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: CLAUDE_MODEL,
      max_tokens: 4096,
      system: EXTRACTION_SYSTEM_PROMPT,
      messages: [{ role: 'user', content: contentBlocks }],
    }),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Claude API error: ${response.status} ${errorText}`);
  }

  const result = await response.json();
  const text = result.content?.[0]?.text || '';
  if (!text) {
    throw new Error('No content in Claude response');
  }

  const extracted = extractJsonFromText(text);
  return { extracted, model: CLAUDE_MODEL };
}
